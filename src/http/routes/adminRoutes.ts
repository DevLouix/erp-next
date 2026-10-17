import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AdminService } from '../../admin/adminService.js';
import type { BackupService } from '../../admin/backupService.js';
import { getAuth, requireAdmin, requireAuth } from '../../auth/middleware.js';
import { serializeInstance, serializeUser } from '../serialize.js';

const roleBody = z.object({ role: z.enum(['user', 'admin']) });
const disabledBody = z.object({ disabled: z.boolean() });
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const createBackupBody = z.object({ label: z.string().max(200).optional() });
const importBody = z.object({
  snapshot: z.unknown().optional(),
  dryRun: z.boolean().optional(),
  baseDomainOverride: z.string().optional(),
});

export function registerAdminRoutes(
  app: FastifyInstance,
  adminService: AdminService,
  backupService: BackupService,
  config: AppConfig,
): void {
  app.get(
    '/api/admin/users',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const users = await adminService.listUsers(user);
      reply.send({ users: users.map(serializeUser) });
    },
  );

  app.get(
    '/api/admin/instances',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const instances = await adminService.listInstances(user);
      reply.send({ instances: instances.map((i) => serializeInstance(i, config)) });
    },
  );

  app.post(
    '/api/admin/instances/:id/retry',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      const instance = await adminService.retryInstance(user, id);
      reply.code(202).send({ instance: serializeInstance(instance, config) });
    },
  );

  app.post(
    '/api/admin/users/:id/disabled',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      const body = disabledBody.parse(request.body ?? {});
      const updated = await adminService.setUserDisabled(user, id, body.disabled);
      reply.send({ user: serializeUser(updated) });
    },
  );

  app.post(
    '/api/admin/users/:id/role',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      const body = roleBody.parse(request.body ?? {});
      const updated = await adminService.setUserRole(user, id, body.role);
      reply.send({ user: serializeUser(updated) });
    },
  );

  app.get(
    '/api/admin/audit',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const query = auditQuery.parse(request.query);
      const entries = await adminService.listAudit(user, query.limit ?? 100);
      reply.send({
        entries: entries.map((e) => ({
          id: e.id,
          actorUserId: e.actorUserId,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          metadata: e.metadata,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    },
  );

  // ── Backups ──────────────────────────────────────────────────────────────

  // Download a live snapshot of platform state as a JSON file.
  app.get(
    '/api/admin/backup/export',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const snapshot = await backupService.exportState(user);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      reply
        .header('content-type', 'application/json')
        .header('content-disposition', `attachment; filename="erpnext-platform-backup-${stamp}.json"`)
        .send(snapshot);
    },
  );

  // Create and store a snapshot in the platform database.
  app.post(
    '/api/admin/backup',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const body = createBackupBody.parse(request.body ?? {});
      const meta = await backupService.createBackup(user, body.label ?? null);
      reply.code(201).send({
        backup: { ...meta, createdAt: meta.createdAt.toISOString() },
      });
    },
  );

  app.get(
    '/api/admin/backup',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const backups = await backupService.listBackups(user);
      reply.send({
        backups: backups.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })),
      });
    },
  );

  app.get(
    '/api/admin/backup/:id/download',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      const backup = await backupService.getBackup(user, id);
      const stamp = backup.createdAt.toISOString().replace(/[:.]/g, '-');
      reply
        .header('content-type', 'application/json')
        .header(
          'content-disposition',
          `attachment; filename="erpnext-platform-backup-${stamp}.json"`,
        )
        .send(backup.payload);
    },
  );

  app.delete(
    '/api/admin/backup/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const { id } = request.params as { id: string };
      await backupService.deleteBackup(user, id);
      reply.code(204).send();
    },
  );

  // Import a snapshot (dry-run optional). Accepts either { snapshot, ... } or a
  // bare snapshot document, so both the dashboard and `curl -d @file` work.
  app.post(
    '/api/admin/backup/import',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { user } = getAuth(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const wrapper = importBody.parse(body);
      const snapshot = wrapper.snapshot ?? body;
      const summary = await backupService.importState(user, snapshot, {
        dryRun: wrapper.dryRun ?? false,
        baseDomainOverride: wrapper.baseDomainOverride ?? null,
      });
      reply.send({ summary });
    },
  );
}
