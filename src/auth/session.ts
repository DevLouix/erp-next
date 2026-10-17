import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, Session, User } from '../domain/types.js';

/**
 * Database-backed sessions.
 *
 * The browser only ever holds an opaque random token in an httpOnly cookie; the
 * server stores a SHA-256 hash of it. This keeps sessions revocable (admin can
 * kill them) and means a leaked cookie value cannot be replayed against a
 * database dump without the raw token.
 */

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionExpiry(config: AppConfig, now = new Date()): Date {
  return new Date(now.getTime() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export interface AuthContext {
  user: User;
  session: Session;
}

export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string, tokens: { accessToken: string | null; refreshToken: string | null }): Promise<{
    token: string;
    session: Session;
  }> {
    const token = generateSessionToken();
    const session = await this.store.createSession({
      tokenHash: hashSessionToken(token),
      userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: sessionExpiry(this.config),
    });
    return { token, session };
  }

  async resolve(token: string | undefined, now = new Date()): Promise<AuthContext | null> {
    if (!token) return null;
    const session = await this.store.findSessionByTokenHash(hashSessionToken(token));
    if (!session) return null;
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.store.deleteSession(session.id);
      return null;
    }
    const user = await this.store.findUserById(session.userId);
    if (!user || user.disabled) return null;
    return { user, session };
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    const session = await this.store.findSessionByTokenHash(hashSessionToken(token));
    if (session) await this.store.deleteSession(session.id);
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.store.deleteSessionsByUser(userId);
  }

  async purgeExpired(now = new Date()): Promise<number> {
    return this.store.deleteExpiredSessions(now);
  }
}

export function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60,
  };
}

export interface InstanceView extends Instance {
  url: string | null;
}

/** Shape instances for the API/dashboard without leaking internal fields. */
export function toInstanceView(instance: Instance, config: AppConfig): InstanceView {
  return {
    ...instance,
    url:
      instance.status === 'ready'
        ? `https://${instance.hostname}`
        : null,
  };
}
