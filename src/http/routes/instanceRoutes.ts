import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { InstanceService } from '../../instances/instanceService.js';
import type { SiteBackupService } from '../../admin/siteBackupService.js';
import { getAuth, requireAuth } from '../../auth/middleware.js';
import { serializeInstance } from '../serialize.js';

const createBody = z.object({
  name: z.string().min(1, 'Company name is required').max(100),
  adminPassword: z.string().min(12).max(128),
  confirmAdminPassword: z.string(),
}).refine((body) => body.adminPassword === body.confirmAdminPassword, {
  message: 'Administrator passwords do not match',
  path: ['confirmAdminPassword'],
});
const updateBody = z.object({
  name: z.string().trim().min(1, 'Company name is required').max(100),
});
const deleteBody = z.object({
  confirmSiteName: z.string().min(1),
});
const credentialsBody = z.object({
  adminPassword: z.string().min(12).max(128),
  confirmAdminPassword: z.string(),
}).refine((body) => body.adminPassword === body.confirmAdminPassword, {
  message: 'Administrator passwords do not match',
  path: ['confirmAdminPassword'],
});
const customDomainBody = z.object({
  domain: z.string().trim().min(1).max(253),
});

export function registerInstanceRoutes(
  app: FastifyInstance,
  instanceService: InstanceService,
  siteBackupService: SiteBackupService,
  config: AppConfig,
): void {
  app.post('/api/instances', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const body = createBody.parse(request.body ?? {});
    const idempotencyKeyHeader = request.headers['idempotency-key'];
    const idempotencyKey =
      typeof idempotencyKeyHeader === 'string' && idempotencyKeyHeader.trim().length > 0
        ? idempotencyKeyHeader.trim().slice(0, 200)
        : null;

    const instance = await instanceService.create(user, {
      companyName: body.name,
      adminPassword: body.adminPassword,
      idempotencyKey,
    });

    reply.code(201).send({ instance: serializeInstance(instance, config) });
  });

  app.get('/api/instances/:id/credentials', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const credentials = await instanceService.loginCredentialsFor(user, id);
    reply
      .header('cache-control', 'no-store, private')
      .header('pragma', 'no-cache')
      .send({ credentials });
  });

  app.post('/api/instances/:id/credentials', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = credentialsBody.parse(request.body ?? {});
    await instanceService.changeLoginPassword(user, id, body.adminPassword);
    reply.code(202).header('cache-control', 'no-store, private').send({ status: 'queued' });
  });

  app.post('/api/instances/:id/domains', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = customDomainBody.parse(request.body ?? {});
    const instance = await instanceService.addCustomDomain(user, id, body.domain);
    reply.code(201).send({
      instance: serializeInstance(instance, config),
      dnsVerification: {
        txtName: `_erpnext-verification.${instance.customDomain}`,
        txtValue: `erpnext-domain-verification=${instance.customDomainVerificationToken}`,
      },
    });
  });

  app.post('/api/instances/:id/domains/verify', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    await instanceService.verifyCustomDomain(user, id);
    reply.code(202).send({ status: 'configuring' });
  });

  app.delete('/api/instances/:id/domains', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    await instanceService.removeCustomDomain(user, id);
    reply.code(202).send({ status: 'removing' });
  });

  app.get('/api/instances', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const instances = await instanceService.listFor(user);
    reply.send({ instances: instances.map((i) => serializeInstance(i, config)) });
  });

  app.get('/api/instances/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const instance = await instanceService.getFor(user, id);
    reply.send({ instance: serializeInstance(instance, config) });
  });

  app.patch('/api/instances/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = updateBody.parse(request.body ?? {});
    const instance = await instanceService.updateFor(user, id, body.name);
    reply.send({ instance: serializeInstance(instance, config) });
  });

  app.delete('/api/instances/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const body = deleteBody.parse(request.body ?? {});
    const instance = await instanceService.deleteFor(user, id, body.confirmSiteName);
    reply.code(202).send({ instance: serializeInstance(instance, config) });
  });

  app.post('/api/instances/:id/retry', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const instance = await instanceService.retry(user, id);
    reply.code(202).send({ instance: serializeInstance(instance, config) });
  });

  app.post('/api/instances/:id/stop-provisioning', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const instance = await instanceService.stopProvisioning(user, id);
    reply.code(202).send({ instance: serializeInstance(instance, config) });
  });

  app.get('/api/instances/:id/backups', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const backups = await siteBackupService.listFor(user, id);
    reply.send({
      backups: backups.map((backup) => ({
        ...backup,
        parts: backup.parts.map((part) => ({
          kind: part.kind,
          sizeBytes: part.sizeBytes,
          downloadUrl: `/api/site-backups/${encodeURIComponent(backup.id)}/files/${part.kind}`,
        })),
        createdAt: backup.createdAt.toISOString(),
        completedAt: backup.completedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post('/api/instances/:id/backups', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    const { id } = request.params as { id: string };
    const backup = await siteBackupService.request(user, id);
    reply.code(202).send({
      backup: { ...backup, parts: [], createdAt: backup.createdAt.toISOString(), completedAt: null },
    });
  });

  app.get(
    '/api/site-backups',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = getAuth(request);
      const backups = await siteBackupService.listVisible(user);
      reply.send({
        backups: backups.map((backup) => ({
          ...backup,
          parts: backup.parts.map((part) => ({
            kind: part.kind,
            sizeBytes: part.sizeBytes,
            downloadUrl: `/api/site-backups/${encodeURIComponent(backup.id)}/files/${part.kind}`,
          })),
          createdAt: backup.createdAt.toISOString(),
          completedAt: backup.completedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.get(
    '/api/site-backups/:id/files/:kind',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id, kind } = request.params as { id: string; kind: string };
      const { backup, part, path } = await siteBackupService.getDownload(user, id, kind);
      reply
        .header('content-type', 'application/octet-stream')
        .header(
          'content-disposition',
          `attachment; filename="${encodeURIComponent(`${backup.siteName}-${part.kind}-${part.relativePath.split('/').at(-1) ?? 'backup'}`)}"`,
        )
        .send(createReadStream(path));
    },
  );
}
