import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, ProvisioningJob, SiteBackupPart } from '../domain/types.js';
import type { Logger } from '../lib/logger.js';
import { consoleLogger } from '../lib/logger.js';
import { redact } from './commands.js';

/** The Bench operations the worker needs. `BenchClient` implements this. */
export interface ProvisioningBench {
  newSite(siteName: string): Promise<unknown>;
  ensureAppInstalled(siteName: string, app: string): Promise<void>;
  setHostname(siteName: string, hostname: string): Promise<void>;
  configureRouting(): Promise<void>;
  dropSite(siteName: string): Promise<unknown>;
  backupSite(siteName: string): Promise<SiteBackupPart[]>;
  uploadBackup(
    siteName: string,
    backupId: string,
    parts: SiteBackupPart[],
    target: Pick<import('../domain/types.js').SiteBackupSettings, 's3Endpoint' | 's3Bucket' | 's3Region'>,
  ): Promise<SiteBackupPart[]>;
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

/** Exponential backoff with a ceiling. `attempt` is 1-based. */
export function computeBackoffMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS);
}

export interface HealthWaiter {
  waitForHealthy(hostname: string): Promise<void>;
}

export interface WorkerDeps {
  store: Store;
  config: AppConfig;
  bench: ProvisioningBench;
  health: HealthWaiter;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type JobOutcome = 'ready' | 'deleted' | 'retry' | 'failed' | 'skipped';

/**
 * Provisions queued instances on the shared Frappe Bench.
 *
 * The worker is the only component that touches the Bench. It assumes no state
 * beyond what is in the platform database, so a crash or restart mid-job is
 * recovered by `recoverStaleJobs` on the next loop.
 */
export class ProvisioningWorker {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopping = false;

  constructor(private readonly deps: WorkerDeps) {
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Claim and fully process at most one job. Returns true when work was done. */
  async runOnce(): Promise<boolean> {
    const scheduledBackups = await this.deps.store.queueScheduledSiteBackups(
      this.now(),
      this.deps.config.PROVISION_MAX_ATTEMPTS,
    );
    if (scheduledBackups > 0) {
      this.logger.info({ count: scheduledBackups }, 'scheduled full-site backups');
    }
    await this.deps.store.recoverStaleJobs(
      this.now(),
      this.deps.config.PROVISION_LOCK_TIMEOUT_MS,
    );
    const job = await this.deps.store.claimNextJob(this.now());
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  async start(): Promise<void> {
    this.running = true;
    this.stopping = false;
    this.logger.info({}, 'provisioning worker started');
    while (!this.stopping) {
      let didWork = false;
      try {
        didWork = await this.runOnce();
      } catch (err) {
        this.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'worker loop error',
        );
      }
      if (!didWork) await this.sleep(this.deps.config.WORKER_POLL_INTERVAL_MS);
    }
    this.running = false;
    this.logger.info({}, 'provisioning worker stopped');
  }

  stop(): void {
    this.stopping = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  async processJob(job: ProvisioningJob): Promise<JobOutcome> {
    const instance = await this.deps.store.findInstanceById(job.instanceId);
    if (!instance) {
      await this.deps.store.failJob(job.id, 'Instance no longer exists');
      return 'failed';
    }

    if (job.type === 'delete') return this.processDeleteJob(job, instance);
    if (job.type === 'backup') return this.processBackupJob(job, instance);

    if (instance.status === 'ready') {
      await this.deps.store.completeJob(job.id);
      return 'ready';
    }

    const log = { jobId: job.id, instanceId: instance.id, hostname: instance.hostname, attempt: job.attempts };
    this.logger.info(log, 'provisioning instance');

    try {
      // On a retry, remove whatever a previous attempt may have left behind so
      // `bench new-site` starts clean. Best-effort: a missing site is fine.
      if (job.attempts > 1) {
        await this.safeDrop(instance);
      }

      await this.setStatus(instance, 'provisioning');
      await this.deps.bench.newSite(instance.siteName);

      await this.setStatus(instance, 'installing');
      await this.deps.bench.ensureAppInstalled(instance.siteName, 'erpnext');

      await this.setStatus(instance, 'configuring');
      await this.deps.bench.setHostname(instance.siteName, instance.hostname);
      await this.configureRouting(log, instance);

      await this.deps.health.waitForHealthy(instance.hostname);

      await this.deps.store.updateInstance(instance.id, {
        status: 'ready',
        errorMessage: null,
      });
      await this.deps.store.completeJob(job.id);
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: 'instance.ready',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { hostname: instance.hostname, attempts: job.attempts },
      });
      this.logger.info(log, 'instance ready');
      return 'ready';
    } catch (err) {
      return this.handleFailure(job, instance, err);
    }
  }

  private async processBackupJob(job: ProvisioningJob, instance: Instance): Promise<JobOutcome> {
    if (!job.siteBackupId) {
      await this.deps.store.failJob(job.id, 'Backup job has no backup record');
      return 'failed';
    }
    const backup = await this.deps.store.findSiteBackup(job.siteBackupId);
    if (!backup) {
      await this.deps.store.failJob(job.id, 'Site backup record no longer exists');
      return 'failed';
    }
    if (instance.status !== 'ready') {
      const message = `Cannot back up an instance in ${instance.status} status`;
      await this.deps.store.updateSiteBackup(backup.id, {
        status: 'failed',
        errorMessage: message,
        completedAt: this.now(),
      });
      await this.deps.store.failJob(job.id, message);
      return 'failed';
    }

    try {
      await this.deps.store.updateSiteBackup(backup.id, {
        status: 'running',
        errorMessage: null,
      });
      const { parts, s3Error } = await this.createBackupParts(instance.siteName, backup.id);
      await this.deps.store.updateSiteBackup(backup.id, {
        status: 'completed',
        parts,
        errorMessage: s3Error,
        completedAt: this.now(),
      });
      await this.deps.store.completeJob(job.id);
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: 'site_backup.completed',
        targetType: 'site_backup',
        targetId: backup.id,
        metadata: {
          siteName: instance.siteName,
          parts: parts.map((part) => part.kind),
          s3UploadError: s3Error,
        },
      });
      return 'ready';
    } catch (err) {
      const message = this.sanitizeError(err);
      if (job.attempts >= job.maxAttempts) {
        await this.deps.store.updateSiteBackup(backup.id, {
          status: 'failed',
          errorMessage: message,
          completedAt: this.now(),
        });
        await this.deps.store.failJob(job.id, message);
        return 'failed';
      }
      await this.deps.store.updateSiteBackup(backup.id, {
        status: 'queued',
        errorMessage: message,
      });
      await this.deps.store.rescheduleJob(
        job.id,
        new Date(this.now().getTime() + computeBackoffMs(job.attempts)),
        message,
      );
      return 'retry';
    }
  }

  private async processDeleteJob(job: ProvisioningJob, instance: Instance): Promise<JobOutcome> {
    const log = {
      jobId: job.id,
      instanceId: instance.id,
      hostname: instance.hostname,
      attempt: job.attempts,
    };
    let s3UploadError: string | null = null;
    this.logger.info(log, 'permanently deleting instance');
    try {
      const safetyBackup = await this.deps.store.createSiteBackupRecord(
        instance.siteName,
        instance.hostname,
        instance.ownerUserId,
      );
      await this.deps.store.updateSiteBackup(safetyBackup.id, { status: 'running' });
      try {
        const { parts, s3Error } = await this.createBackupParts(instance.siteName, safetyBackup.id);
        s3UploadError = s3Error;
        await this.deps.store.updateSiteBackup(safetyBackup.id, {
          status: 'completed',
          parts,
          errorMessage: s3Error,
          completedAt: this.now(),
        });
        if (s3Error) {
          this.logger.warn(
            { ...log, backupId: safetyBackup.id, error: s3Error },
            'S3 upload failed; verified local pre-deletion backup retained',
          );
        }
      } catch (err) {
        await this.deps.store.updateSiteBackup(safetyBackup.id, {
          status: 'failed',
          errorMessage: this.sanitizeError(err),
          completedAt: this.now(),
        });
        throw err;
      }
      await this.deps.bench.dropSite(instance.siteName);
      await this.deps.store.deleteInstance(instance.id);
      try {
        await this.deps.store.recordAudit({
          actorUserId: null,
          action: 'instance.deleted',
          targetType: 'instance',
          targetId: instance.id,
          metadata: {
            hostname: instance.hostname,
            attempts: job.attempts,
            s3UploadError,
          },
        });
      } catch (err) {
        this.logger.error(
          { ...log, error: err instanceof Error ? err.message : String(err) },
          'could not record completed site deletion in audit log',
        );
      }
      try {
        await this.configureRouting(log, instance);
      } catch (err) {
        this.logger.warn(
          { ...log, error: err instanceof Error ? err.message : String(err) },
          'routing refresh failed after site deletion',
        );
      }
      this.logger.info(log, 'instance permanently deleted');
      return 'deleted';
    } catch (err) {
      const message = this.sanitizeError(err);
      this.logger.error({ ...log, error: message }, 'instance deletion failed');
      if (job.attempts >= job.maxAttempts) {
        await this.deps.store.failJob(job.id, message);
        await this.deps.store.updateInstance(instance.id, {
          status: 'failed',
          errorMessage: message,
        });
        return 'failed';
      }
      await this.deps.store.rescheduleJob(
        job.id,
        new Date(this.now().getTime() + computeBackoffMs(job.attempts)),
        message,
      );
      return 'retry';
    }
  }

  private async createBackupParts(
    siteName: string,
    backupId: string,
  ): Promise<{ parts: SiteBackupPart[]; s3Error: string | null }> {
    const parts = await this.deps.bench.backupSite(siteName);
    const settings = await this.deps.store.getSiteBackupSettings();
    if (!settings.s3Endpoint && !settings.s3Bucket) return { parts, s3Error: null };
    try {
      return {
        parts: await this.deps.bench.uploadBackup(siteName, backupId, parts, settings),
        s3Error: null,
      };
    } catch (err) {
      const message = this.sanitizeError(err);
      this.logger.error(
        { siteName, backupId, error: message },
        'S3 upload failed; verified local site backup retained',
      );
      return {
        parts,
        s3Error: 'S3 upload failed; verified local backup remains available',
      };
    }
  }

  private async handleFailure(
    job: ProvisioningJob,
    instance: Instance,
    err: unknown,
  ): Promise<JobOutcome> {
    const message = this.sanitizeError(err);
    const exhausted = job.attempts >= job.maxAttempts;

    this.logger.error(
      { jobId: job.id, instanceId: instance.id, attempt: job.attempts, error: message },
      'provisioning attempt failed',
    );

    await this.safeDrop(instance);

    if (exhausted) {
      await this.deps.store.failJob(job.id, message);
      await this.deps.store.updateInstance(instance.id, { status: 'failed', errorMessage: message });
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: 'instance.failed',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { attempts: job.attempts, error: message },
      });
      return 'failed';
    }

    const delay = computeBackoffMs(job.attempts);
    await this.deps.store.rescheduleJob(job.id, new Date(this.now().getTime() + delay), message);
    await this.deps.store.updateInstance(instance.id, { status: 'queued', errorMessage: message });
    return 'retry';
  }

  private async setStatus(instance: Instance, status: Instance['status']): Promise<void> {
    await this.deps.store.updateInstance(instance.id, { status, errorMessage: null });
  }

  /**
   * Regenerate the reverse-proxy vhosts. In topologies where nginx is owned by
   * the worker host this is authoritative (`strict`); where the ingress is a
   * separate service the health check is the real gate (`best-effort`).
   */
  private async configureRouting(
    log: Record<string, unknown>,
    instance: Instance,
  ): Promise<void> {
    const mode = this.deps.config.PROVISION_ROUTING_MODE;
    if (mode === 'skip') return;
    try {
      await this.deps.bench.configureRouting();
    } catch (err) {
      if (mode === 'strict') throw err;
      this.logger.warn(
        { ...log, error: err instanceof Error ? err.message : String(err) },
        'nginx routing update failed (best-effort); relying on health check',
      );
    }
  }

  private async safeDrop(instance: Instance): Promise<void> {
    try {
      await this.deps.bench.dropSite(instance.siteName);
    } catch {
      // Nothing to clean up, or cleanup itself failed; the next attempt retries.
    }
  }

  private sanitizeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return redact(raw, [
      this.deps.config.MARIADB_ROOT_PASSWORD,
      this.deps.config.ERPNEXT_ADMIN_PASSWORD,
    ]).slice(0, 1000);
  }
}
