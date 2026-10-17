import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AuthService } from '../../auth/authService.js';
import { getAuth, requireAuth } from '../../auth/middleware.js';
import { sessionCookieOptions } from '../../auth/session.js';

const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  config: AppConfig,
): void {
  app.get('/auth/login', async (_request, reply) => {
    const { url } = await authService.startLogin();
    await reply.redirect(url, 302);
  });

  app.get('/auth/callback', async (request, reply) => {
    const query = callbackQuery.parse(request.query);
    try {
      const { sessionToken } = await authService.completeLogin({
        code: query.code,
        state: query.state,
        error: query.error ?? (query.error_description ? 'access_denied' : undefined),
      });
      reply.setCookie(config.SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions(config));
      await reply.redirect('/dashboard', 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed';
      await reply.redirect(`/login?error=${encodeURIComponent(message)}`, 302);
    }
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    await authService.logout(request.sessionToken, user.id);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    await reply.redirect('/login', 302);
  });

  // Redirect to the provider's RP-initiated logout, then back to /login.
  app.get('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = getAuth(request);
    await authService.logout(request.sessionToken, user.id);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    await reply.redirect(authService.logoutUrl(), 302);
  });
}
