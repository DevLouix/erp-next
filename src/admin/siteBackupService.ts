import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type {
  SiteBackup,
  SiteBackupPartKind,
  SiteBackupSettings,
  User,
} from '../domain/types.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { InstanceService } from '../instances/instanceService.js';
import { encryptCredential } from './credentialEncryption.js';

const partKinds: SiteBackupPartKind[] = [
  'database',
  'public-files',
  'private-files',
  'site-config',
];

export class SiteBackupService {
  constructor(
    private readonly store: Store,
    private readonly instances: InstanceService,
    private readonly config: AppConfig,
  ) {}

  async request(actor: User, instanceId: string): Promise<SiteBackup> {
    const instance = await this.instances.getFor(actor, instanceId);
    if (instance.status !== 'ready') {
      throw new ValidationError('Only ready instances can be backed up');
    }
    const backup = await this.store.queueSiteBackup(
      instance,
      actor.id,
      this.config.PROVISION_MAX_ATTEMPTS,
    );
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'site_backup.request',
      targetType: 'site_backup',
      targetId: backup.id,
      metadata: { siteName: instance.siteName, hostname: instance.hostname },
    });
    return backup;
  }

  async listFor(actor: User, instanceId: string): Promise<SiteBackup[]> {
    const instance = await this.instances.getFor(actor, instanceId);
    return this.hideSiteConfig(actor, await this.store.listSiteBackups(instance.siteName));
  }

  async listAllForAdmin(actor: User): Promise<SiteBackup[]> {
    this.assertAdmin(actor);
    return this.store.listAllSiteBackups();
  }

  async listVisible(actor: User): Promise<SiteBackup[]> {
    const backups = actor.role === 'admin'
      ? this.store.listAllSiteBackups()
      : this.store.listSiteBackupsByOwner(actor.id);
    return this.hideSiteConfig(actor, await backups);
  }

  async getSettings(actor: User): Promise<SiteBackupSettings> {
    this.assertAdmin(actor);
    return this.store.getSiteBackupSettings();
  }

  async updateSettings(
    actor: User,
    input: Pick<
      SiteBackupSettings,
      'automaticEnabled' | 'intervalHours' | 's3Endpoint' | 's3Bucket' | 's3Region'
    > & {
      s3AccessKeyId?: string;
      s3SecretAccessKey?: string;
      clearS3Credentials?: boolean;
    },
  ): Promise<SiteBackupSettings> {
    this.assertAdmin(actor);
    if (![24, 168].includes(input.intervalHours)) {
      throw new ValidationError('Automatic backup interval must be daily or weekly');
    }
    const s3Fields = [input.s3Endpoint, input.s3Bucket, input.s3Region];
    const hasSomeS3Settings = s3Fields.some(Boolean);
    const hasAllS3Settings = s3Fields.every(Boolean);
    if (hasSomeS3Settings !== hasAllS3Settings) {
      throw new ValidationError('Configure the S3 endpoint, bucket, and region together, or leave all empty');
    }
    if (input.s3Endpoint) {
      let endpoint: URL;
      try {
        endpoint = new URL(input.s3Endpoint);
      } catch {
        throw new ValidationError('S3 endpoint must be a valid HTTP(S) URL');
      }
      if (!['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new ValidationError('S3 endpoint must be HTTP(S) and must not contain credentials or query parameters');
      }
      if (!input.s3Bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.s3Bucket)) {
        throw new ValidationError('S3 bucket name is invalid');
      }
      if (!input.s3Region?.trim()) throw new ValidationError('S3 region is required');
    }
    const hasAccessKey = Boolean(input.s3AccessKeyId);
    const hasSecretKey = Boolean(input.s3SecretAccessKey);
    if (hasAccessKey !== hasSecretKey) {
      throw new ValidationError('Provide both the S3 access key ID and secret access key');
    }
    if (input.clearS3Credentials && hasAccessKey) {
      throw new ValidationError('Choose either new S3 credentials or clear existing credentials');
    }
    const currentSettings = await this.store.getSiteBackupSettings();
    if (input.clearS3Credentials && hasAllS3Settings) {
      throw new ValidationError('S3 credentials are required while an S3 backup target is configured');
    }
    if (hasAllS3Settings && !hasAccessKey && !currentSettings.s3CredentialsConfigured) {
      throw new ValidationError('Enter S3 credentials before enabling the S3 backup target');
    }
    let credentials;
    if (hasAccessKey) {
      try {
        credentials = {
          accessKeyCiphertext: encryptCredential(
            input.s3AccessKeyId!,
            this.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
          ),
          secretKeyCiphertext: encryptCredential(
            input.s3SecretAccessKey!,
            this.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
          ),
        };
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : 'Could not encrypt S3 credentials');
      }
    } else {
      credentials = input.clearS3Credentials ? null : undefined;
    }
    const { s3AccessKeyId: _accessKey, s3SecretAccessKey: _secretKey, clearS3Credentials: _clear, ...settingsInput } = input;
    const settings = await this.store.updateSiteBackupSettings(
      settingsInput,
      new Date(),
      credentials,
    );
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'site_backup.settings_update',
      targetType: 'site_backup_settings',
      targetId: null,
      metadata: {
        automaticEnabled: settings.automaticEnabled,
        intervalHours: settings.intervalHours,
        s3Configured: Boolean(settings.s3Endpoint && settings.s3Bucket),
      },
    });
    return settings;
  }

  async getDownload(actor: User, backupId: string, kind: string): Promise<{
    backup: SiteBackup;
    part: SiteBackup['parts'][number];
    path: string;
  }> {
    const backup = await this.store.findSiteBackup(backupId);
    if (!backup) throw new NotFoundError('Site backup not found');
    if (actor.role !== 'admin' && backup.createdByUserId !== actor.id) {
      throw new NotFoundError('Site backup not found');
    }
    if (kind === 'site-config' && actor.role !== 'admin') {
      throw new NotFoundError('Site backup not found');
    }
    if (backup.status !== 'completed' && backup.parts.length === 0) {
      throw new ValidationError('This site backup is not ready to download');
    }
    const partKind = partKinds.find((candidate) => candidate === kind);
    if (!partKind) {
      throw new ValidationError('Invalid backup file type');
    }
    const part = backup.parts.find((candidate) => candidate.kind === partKind);
    if (!part) throw new NotFoundError('This backup does not contain that file');
    if (part.kind === 'site-config' && actor.role !== 'admin') {
      throw new NotFoundError('Site backup not found');
    }

    const root = resolve(this.config.BENCH_PATH, 'archived-backups');
    const path = resolve(root, part.relativePath);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new ValidationError('Invalid backup file path');
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ValidationError('Backup artifact is not a regular file');
    }
    return { backup, part, path };
  }

  private assertAdmin(actor: User): void {
    if (actor.role !== 'admin') throw new ForbiddenError('Administrator role required');
  }

  private hideSiteConfig(actor: User, backups: SiteBackup[]): SiteBackup[] {
    if (actor.role === 'admin') return backups;
    return backups.map((backup) => ({
      ...backup,
      parts: backup.parts.filter((part) => part.kind !== 'site-config'),
    }));
  }
}
