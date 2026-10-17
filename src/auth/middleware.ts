import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from './authService.js';
import type { AuthContext } from './session.js';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    sessionToken?: string;
  }
}

export function registerAuthDecorators(app: import('fastify').FastifyInstance): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('sessionToken', undefined);
}

export function registerAuthHook(
  app: import('fastify').FastifyInstance,
  authService: AuthService,
  config: AppConfig,
): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    request.sessionToken = token;
    request.auth = await authService.sessions.resolve(token);
  });
}

export function getAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('getAuth called without an authenticated request');
  return request.auth;
}

/** Reject unauthenticated requests. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
  }
}

/** Reject non-admins. Must run after `requireAuth`. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    await reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
    return;
  }
  if (request.auth.user.role !== 'admin') {
    await reply.code(403).send({ error: 'forbidden', message: 'Administrator role required' });
  }
}

/**
 * Defence-in-depth CSRF check: for state-changing requests that carry an
 * `Origin`, it must match the configured public base URL. Non-browser clients
 * (no Origin) are allowed; the session cookie is SameSite=Lax regardless.
 */
export function registerOriginCheck(
  app: import('fastify').FastifyInstance,
  config: AppConfig,
): void {
  const expected = new URL(config.PUBLIC_BASE_URL).host;
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const origin = request.headers.origin;
    if (!origin) return;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      await reply.code(403).send({ error: 'forbidden', message: 'Invalid origin' });
      return;
    }
    if (host !== expected) {
      await reply.code(403).send({ error: 'forbidden', message: 'Cross-origin request rejected' });
    }
  });
}
