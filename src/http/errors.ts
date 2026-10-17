import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `Route not found: ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      reply
        .code(400)
        .send({ error: 'validation_error', message: error.message, details: error.details });
      return;
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'validation_error',
        message: 'Invalid request',
        details: Object.fromEntries(error.issues.map((i) => [i.path.join('.') || '_', i.message])),
      });
      return;
    }
    if (error instanceof UnauthorizedError) {
      reply.code(401).send({ error: 'unauthorized', message: error.message });
      return;
    }
    if (error instanceof ForbiddenError) {
      reply.code(403).send({ error: 'forbidden', message: error.message });
      return;
    }
    if (error instanceof NotFoundError) {
      reply.code(404).send({ error: 'not_found', message: error.message });
      return;
    }
    if (error instanceof DuplicateError) {
      reply.code(409).send({ error: 'conflict', message: 'Resource already exists' });
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({
        error: 'request_error',
        message: error instanceof Error ? error.message : 'Request error',
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({ error: 'internal_error', message: 'An unexpected error occurred' });
  });
}
