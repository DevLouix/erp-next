import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { InstanceService } from '../../instances/instanceService.js';
import { getAuth, requireAuth } from '../../auth/middleware.js';
import { serializeInstance } from '../serialize.js';

const createBody = z.object({
  name: z.string().min(1, 'Company name is required').max(100),
});

export function registerInstanceRoutes(
  app: FastifyInstance,
  instanceService: InstanceService,
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
      idempotencyKey,
    });

    reply.code(201).send({ instance: serializeInstance(instance, config) });
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
}
