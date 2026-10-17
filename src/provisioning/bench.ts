import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CommandRunner, CommandResult } from './commands.js';
import { BenchCommandError, redact } from './commands.js';
import type { SiteBackupPart, SiteBackupSettings } from '../domain/types.js';

export interface BenchConfig {
  benchBin: string;
  benchPath: string;
  mariadbRootPassword: string;
  erpnextAdminPassword: string;
  mariadbHost?: string;
  erpnextApp: string;
  backupPath?: string;
}

/**
 * Thin wrapper around the supported `bench` CLI.
 *
 * Every method maps to a documented Frappe Bench command. No method accepts a
 * caller-provided flag or free-form argument: the only variable inputs are the
 * already-validated site name and hostname.
 */
export class BenchClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: BenchConfig,
  ) {}

  private get secrets(): string[] {
    return [this.config.mariadbRootPassword, this.config.erpnextAdminPassword];
  }

  private async bench(args: string[]): Promise<CommandResult> {
    const result = await this.runner.run(this.config.benchBin, args, {
      cwd: this.config.benchPath,
    });
    return {
      ...result,
      stdout: redact(result.stdout, this.secrets),
      stderr: redact(result.stderr, this.secrets),
    };
  }

  private assertOk(result: CommandResult, description: string): void {
    if (result.code !== 0) {
      const detail = redact((result.stderr || result.stdout).trim(), this.secrets).slice(0, 500);
      throw new BenchCommandError(
        `${description} failed${detail ? `: ${detail}` : ''}`,
        result,
      );
    }
  }

  /** `bench new-site` — creates the site directory and its MariaDB database. */
  async newSite(siteName: string): Promise<CommandResult> {
    const args = [
      'new-site',
      siteName,
      '--admin-password',
      this.config.erpnextAdminPassword,
      '--mariadb-root-password',
      this.config.mariadbRootPassword,
      '--no-mariadb-socket',
    ];
    if (this.config.mariadbHost) args.push('--db-host', this.config.mariadbHost);
    const result = await this.bench(args);
    this.assertOk(result, `Creating site ${siteName}`);
    return result;
  }

  /** `bench --site <site> list-apps` — returns installed app names. */
  async listApps(siteName: string): Promise<string[]> {
    const result = await this.bench(['--site', siteName, 'list-apps']);
    this.assertOk(result, `Listing apps for ${siteName}`);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0] ?? line);
  }

  /** `bench --site <site> install-app <app>` */
  async installApp(siteName: string, app: string): Promise<CommandResult> {
    const result = await this.bench(['--site', siteName, 'install-app', app]);
    this.assertOk(result, `Installing ${app} on ${siteName}`);
    return result;
  }

  /** Ensure the ERPNext app is present on the site exactly once. */
  async ensureAppInstalled(siteName: string, app: string): Promise<void> {
    const apps = await this.listApps(siteName);
    if (apps.includes(app)) return;
    await this.installApp(siteName, app);
  }

  /** Persist the canonical hostname in the site config. */
  async setHostname(siteName: string, hostname: string): Promise<void> {
    const result = await this.bench([
      '--site',
      siteName,
      'set-config',
      'host_name',
      `https://${hostname}`,
    ]);
    this.assertOk(result, `Configuring hostname for ${siteName}`);
  }

  /** Regenerate nginx configuration; the deployment's ingress owns reloads. */
  async configureRouting(): Promise<void> {
    const setup = await this.bench(['setup', 'nginx']);
    this.assertOk(setup, 'Regenerating nginx configuration');
  }

  /** Best-effort teardown of a partially provisioned site. */
  async dropSite(siteName: string): Promise<CommandResult> {
    const result = await this.bench([
      'drop-site',
      siteName,
      '--force',
      '--no-backup',
      '--mariadb-root-password',
      this.config.mariadbRootPassword,
    ]);
    this.assertOk(result, `Deleting site ${siteName}`);
    return result;
  }

  /** Create a complete Bench backup and copy it outside the tenant site directory. */
  async backupSite(siteName: string): Promise<SiteBackupPart[]> {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(siteName) || siteName.includes('..')) {
      throw new Error('Invalid site name for backup');
    }
    const sourceDir = join(this.config.benchPath, 'sites', siteName, 'private', 'backups');
    const backupRoot = this.config.backupPath ?? join(this.config.benchPath, 'archived-backups');
    const startedAt = Date.now();
    const result = await this.bench(['--site', siteName, 'backup', '--with-files']);
    this.assertOk(result, `Backing up site ${siteName}`);

    const candidates = await Promise.all(
      (await readdir(sourceDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const metadata = await stat(join(sourceDir, entry.name));
          const kind = this.backupPartKind(entry.name);
          return {
            name: entry.name,
            kind,
            modifiedAt: metadata.mtimeMs,
            sizeBytes: metadata.size,
          };
        }),
    );
    const created = candidates.filter((file) => file.modifiedAt >= startedAt - 5_000);
    const selected = (['database', 'public-files', 'private-files', 'site-config'] as const)
      .map((kind) =>
        created
          .filter((file) => file.kind === kind)
          .sort((a, b) => b.modifiedAt - a.modifiedAt)[0],
      )
      .filter((file): file is NonNullable<typeof file> => file !== undefined);
    const requiredKinds = ['database', 'public-files', 'private-files', 'site-config'] as const;
    const missingKinds = requiredKinds.filter(
      (kind) => !selected.some((file) => file.kind === kind),
    );
    if (missingKinds.length > 0) {
      throw new Error(
        `Bench backup for ${siteName} is missing required archives: ${missingKinds.join(', ')}`,
      );
    }
    const emptyArchives = selected.filter((file) => file.sizeBytes === 0);
    if (emptyArchives.length > 0) {
      throw new Error(
        `Bench backup for ${siteName} produced empty archives: ${emptyArchives.map((file) => file.kind).join(', ')}`,
      );
    }

    const destinationDir = join(backupRoot, siteName, `${Date.now()}-${randomUUID()}`);
    const stagingDir = `${destinationDir}.partial`;
    await mkdir(dirname(destinationDir), { recursive: true });
    await mkdir(stagingDir);
    try {
      const parts = await Promise.all(
        selected.map(async (file) => {
          const destination = join(stagingDir, file.name);
          await copyFile(join(sourceDir, file.name), destination);
          await chmod(destination, 0o600);
          const copied = await stat(destination);
          if (copied.size !== file.sizeBytes) {
            throw new Error(`Backup archive copy was incomplete: ${file.name}`);
          }
          return {
            kind: file.kind!,
            relativePath: relative(backupRoot, join(destinationDir, file.name)),
            sizeBytes: copied.size,
          };
        }),
      );
      await rename(stagingDir, destinationDir);
      return parts;
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  private backupPartKind(name: string): SiteBackupPart['kind'] | null {
    if (/-private-files(?:-enc)?\.tar(?:\.gz)?$/.test(name)) return 'private-files';
    if (/-files(?:-enc)?\.tar(?:\.gz)?$/.test(name)) return 'public-files';
    if (/-database(?:-enc)?\.sql\.gz$/.test(name)) return 'database';
    if (/-site_config_backup(?:-enc)?\.json$/.test(name)) return 'site-config';
    return null;
  }

  async uploadBackup(
    siteName: string,
    backupId: string,
    parts: SiteBackupPart[],
    target: Pick<SiteBackupSettings, 's3Endpoint' | 's3Bucket' | 's3Region'>,
    credentials: { accessKeyId: string; secretAccessKey: string },
  ): Promise<SiteBackupPart[]> {
    const endpoint = target.s3Endpoint;
    const bucket = target.s3Bucket;
    const region = target.s3Region;
    if (!endpoint || !bucket || !region) {
      throw new Error('S3 backup target is incomplete');
    }
    const backupRoot = this.config.backupPath ?? join(this.config.benchPath, 'archived-backups');
    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials,
    });
    try {
      return await Promise.all(
        parts.map(async (part) => {
          const path = resolve(backupRoot, part.relativePath);
          const relativePath = relative(backupRoot, path);
          if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
            throw new Error('Invalid local backup artifact path');
          }
          const key = `erpnext-backups/${siteName}/${backupId}/${basename(path)}`;
          await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: createReadStream(path),
            ContentLength: part.sizeBytes,
            ServerSideEncryption: 'AES256',
          }));
          return { ...part, s3ObjectKey: key };
        }),
      );
    } finally {
      client.destroy();
    }
  }
}
