import type { UserInfo } from '@truemoi/sdk';
import type {
  BeginLoginResult,
  ExchangedTokens,
  IdentityProvider,
} from '../../src/auth/identityProvider.js';
import type { ProvisioningBench } from '../../src/provisioning/worker.js';
import type { HealthWaiter } from '../../src/provisioning/worker.js';
import type { SiteBackupPart } from '../../src/domain/types.js';
import type { SiteBackupSettings } from '../../src/domain/types.js';

/** A scriptable stand-in for Truemoi that never touches the network. */
export class FakeIdentityProvider implements IdentityProvider {
  /** Populated on each beginLogin; keyed by state. */
  private issued = new Map<string, { codeVerifier: string; redirectUri: string; user: UserInfo }>();
  private counter = 0;
  private stateToAccessToken = new Map<string, string>();

  /** The profile returned for the next completed login. */
  currentUser: UserInfo = {
    sub: 'user-1',
    email: 'user1@example.test',
    name: 'User One',
    role: 'user',
  };

  beginLoginCalls = 0;

  async beginLogin(redirectUri: string): Promise<BeginLoginResult> {
    this.counter += 1;
    const state = `state-${this.counter}`;
    const codeVerifier = `verifier-${this.counter}`;
    this.issued.set(state, { codeVerifier, redirectUri, user: { ...this.currentUser } });
    return {
      url: `https://idp.example.test/auth?state=${state}`,
      state,
      nonce: `nonce-${this.counter}`,
      codeVerifier,
      redirectUri,
    };
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    state: string;
  }): Promise<ExchangedTokens> {
    const issued = this.issued.get(params.state);
    if (!issued) throw new Error('unknown state');
    if (issued.codeVerifier !== params.codeVerifier) throw new Error('PKCE verification failed');
    if (!params.code) throw new Error('missing code');
    const accessToken = `access:${params.state}`;
    this.stateToAccessToken.set(accessToken, params.state);
    return {
      accessToken,
      refreshToken: `refresh:${params.state}`,
      idToken: `id:${params.state}`,
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async getUserInfo(accessToken: string): Promise<UserInfo> {
    const state = this.stateToAccessToken.get(accessToken);
    if (!state) throw new Error('invalid token');
    const issued = this.issued.get(state);
    if (!issued) throw new Error('invalid token');
    return issued.user;
  }

  getLogoutUrl(postLogoutRedirectUri: string): string {
    return `https://idp.example.test/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
  }
}

export interface BenchCall {
  op: string;
  args: unknown[];
}

/** Records bench operations and can be told to fail specific steps. */
export class FakeBench implements ProvisioningBench {
  calls: BenchCall[] = [];
  installedApps = new Set<string>();
  failOn: Set<string> = new Set();
  failMessage: string | null = null;
  siteExists = false;

  private maybeFail(op: string): void {
    if (this.failOn.has(op)) throw new Error(this.failMessage ?? `bench ${op} failed`);
  }

  async newSite(siteName: string): Promise<void> {
    this.calls.push({ op: 'new-site', args: [siteName] });
    this.maybeFail('newSite');
    this.siteExists = true;
  }

  async ensureAppInstalled(siteName: string, app: string): Promise<void> {
    this.calls.push({ op: 'ensure-app', args: [siteName, app] });
    this.maybeFail('ensureAppInstalled');
    this.installedApps.add(app);
  }

  async setHostname(siteName: string, hostname: string): Promise<void> {
    this.calls.push({ op: 'set-hostname', args: [siteName, hostname] });
    this.maybeFail('setHostname');
  }

  async configureRouting(): Promise<void> {
    this.calls.push({ op: 'configure-routing', args: [] });
    this.maybeFail('configureRouting');
  }

  async dropSite(siteName: string): Promise<void> {
    this.calls.push({ op: 'drop-site', args: [siteName] });
    this.maybeFail('dropSite');
    this.siteExists = false;
  }

  async backupSite(siteName: string): Promise<SiteBackupPart[]> {
    this.calls.push({ op: 'backup-site', args: [siteName] });
    this.maybeFail('backupSite');
    return [
      { kind: 'database', relativePath: `${siteName}/backup.sql.gz`, sizeBytes: 1024 },
      { kind: 'public-files', relativePath: `${siteName}/files.tar`, sizeBytes: 512 },
      { kind: 'private-files', relativePath: `${siteName}/private-files.tar`, sizeBytes: 512 },
      { kind: 'site-config', relativePath: `${siteName}/site_config_backup.json`, sizeBytes: 128 },
    ];
  }

  async uploadBackup(
    siteName: string,
    backupId: string,
    parts: SiteBackupPart[],
    _target: Pick<SiteBackupSettings, 's3Endpoint' | 's3Bucket' | 's3Region'>,
    _credentials: { accessKeyId: string; secretAccessKey: string },
  ): Promise<SiteBackupPart[]> {
    this.calls.push({ op: 'upload-backup', args: [siteName, backupId] });
    this.maybeFail('uploadBackup');
    return parts.map((part) => ({
      ...part,
      s3ObjectKey: `erpnext-backups/${siteName}/${backupId}/${part.kind}`,
    }));
  }
}

/** Health checker that succeeds after `failTimes` attempts. */
export class FakeHealth implements HealthWaiter {
  attempts = 0;
  constructor(private readonly failTimes = 0) {}

  async waitForHealthy(hostname: string): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failTimes) throw new Error(`site ${hostname} not healthy yet`);
  }
}
