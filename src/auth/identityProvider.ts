import { TruemoiOAuth } from '@truemoi/sdk';
import type { UserInfo } from '@truemoi/sdk';
import type { AppConfig } from '../config.js';

export interface BeginLoginResult {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: Date;
}

/**
 * The subset of Truemoi we depend on. Defining it as an interface keeps the
 * HTTP/token layer testable without reaching the real identity provider.
 */
export interface IdentityProvider {
  beginLogin(redirectUri: string): Promise<BeginLoginResult>;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    state: string;
  }): Promise<ExchangedTokens>;
  getUserInfo(accessToken: string): Promise<UserInfo>;
  getLogoutUrl(postLogoutRedirectUri: string, idTokenHint?: string): string;
}

export class TruemoiIdentityProvider implements IdentityProvider {
  private readonly oauth: TruemoiOAuth;

  constructor(private readonly config: AppConfig) {
    this.oauth = new TruemoiOAuth({
      clientId: config.TRUEMOI_CLIENT_ID,
      authDomain: config.TRUEMOI_AUTH_DOMAIN,
      apiUrl: config.TRUEMOI_API_URL,
      authRealm: config.TRUEMOI_AUTH_REALM,
    });
  }

  async beginLogin(redirectUri: string): Promise<BeginLoginResult> {
    const login = await this.oauth.beginLogin({
      redirectUri,
      scope: this.config.TRUEMOI_SCOPES,
    });
    return {
      url: login.url,
      state: login.state,
      nonce: login.nonce,
      codeVerifier: login.codeVerifier,
      redirectUri,
    };
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    state: string;
  }): Promise<ExchangedTokens> {
    const tokens = await this.oauth.exchangeCode(
      params.code,
      params.redirectUri,
      params.codeVerifier,
      params.state,
      this.config.TRUEMOI_CLIENT_SECRET,
    );
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
      expiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
    };
  }

  async getUserInfo(accessToken: string): Promise<UserInfo> {
    return this.oauth.getUserInfo(accessToken);
  }

  getLogoutUrl(postLogoutRedirectUri: string, idTokenHint?: string): string {
    return this.oauth.getLogoutUrl({ postLogoutRedirectUri, idTokenHint });
  }
}
