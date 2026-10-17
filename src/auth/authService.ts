import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { User } from '../domain/types.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../domain/errors.js';
import type { IdentityProvider } from './identityProvider.js';
import { SessionService } from './session.js';
import { resolveRole } from './roles.js';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface LoginCompletion {
  user: User;
  sessionToken: string;
}

export class AuthService {
  readonly sessions: SessionService;

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly identity: IdentityProvider,
  ) {
    this.sessions = new SessionService(store, config);
  }

  callbackUrl(): string {
    return new URL('/auth/callback', this.config.PUBLIC_BASE_URL).toString();
  }

  /** Begin the authorization-code + PKCE flow and persist the transaction. */
  async startLogin(): Promise<{ url: string }> {
    const login = await this.identity.beginLogin(this.callbackUrl());
    const now = new Date();
    await this.store.createOAuthTransaction({
      state: login.state,
      codeVerifier: login.codeVerifier,
      nonce: login.nonce,
      redirectUri: login.redirectUri,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TRANSACTION_TTL_MS),
    });
    await this.store.deleteExpiredOAuthTransactions(now);
    return { url: login.url };
  }

  /**
   * Finish the flow from the callback.
   *
   * The state is single-use: it is consumed before the code exchange, so a
   * replayed callback cannot succeed and a forged `state` is rejected outright.
   */
  async completeLogin(params: {
    code: string | undefined;
    state: string | undefined;
    error: string | undefined;
  }): Promise<LoginCompletion> {
    if (params.error) {
      throw new UnauthorizedError(`Identity provider returned an error: ${params.error}`);
    }
    if (!params.code || !params.state) {
      throw new ValidationError('Missing authorization code or state');
    }
    const now = new Date();
    const transaction = await this.store.consumeOAuthTransaction(params.state, now);
    if (!transaction) {
      throw new UnauthorizedError('Invalid or expired login transaction');
    }

    const tokens = await this.identity.exchangeCode({
      code: params.code,
      redirectUri: transaction.redirectUri,
      codeVerifier: transaction.codeVerifier,
      state: params.state,
    });

    const info = await this.identity.getUserInfo(tokens.accessToken);
    if (!info.sub) {
      throw new UnauthorizedError('Identity provider response did not include a subject');
    }

    const email = info.email ?? info.preferred_username ?? `${info.sub}@truemoi.invalid`;
    const existing = await this.store.findUserByOauthSubject(info.sub);
    const role = resolveRole({
      truemoiRole: info.role,
      email,
      existingRole: existing?.role ?? null,
      config: this.config,
    });

    const user = existing
      ? await this.store.updateUser(existing.id, {
          email,
          name: info.name ?? existing.name,
          role,
        })
      : await this.store.createUser({
          oauthSubject: info.sub,
          email,
          name: info.name ?? null,
          role,
        });

    if (user.disabled) {
      throw new ForbiddenError('This account has been disabled');
    }

    const { token } = await this.sessions.create(user.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });

    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: user.role },
    });

    return { user, sessionToken: token };
  }

  async logout(sessionToken: string | undefined, actorUserId?: string): Promise<void> {
    await this.sessions.destroy(sessionToken);
    if (actorUserId) {
      await this.store.recordAudit({
        actorUserId,
        action: 'auth.logout',
        targetType: 'user',
        targetId: actorUserId,
        metadata: null,
      });
    }
  }

  logoutUrl(): string {
    return this.identity.getLogoutUrl(this.config.PUBLIC_BASE_URL);
  }
}
