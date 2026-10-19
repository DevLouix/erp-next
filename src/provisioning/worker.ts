import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, ProvisioningJob, SiteBackupPart } from '../domain/types.js';
import type { Logger } from '../lib/logger.js';
import { consoleLogger } from '../lib/logger.js';
import { redact } from './commands.js';
import { decryptCredential } from '../admin/credentialEncryption.js';
import type { DomainIngress } from './domainIngress.js';

/** The Bench operations the worker needs. `BenchClient` implements this. */
export interface ProvisioningBench {
  newSite(siteName: string, adminPassword?: string): Promise<unknown>;
  setAdminPassword(siteName: string, password: string): Promise<void>;
  ensureAppInstalled(siteName: string, app: string): Promise<void>;
  setHostname(siteName: string, hostname: string): Promise<void>;
  addDomain(siteName: string, domain: string): Promise<void>;
  removeDomain(siteName: string, domain: string): Promise<void>;
  configureRouting(): Promise<void>;
  dropSite(siteName: string): Promise<unknown>;
  backupSite(siteName: string): Promise<SiteBackupPart[]>;
  uploadBackup(
    siteName: string,
    backupId: string,
    parts: SiteBackupPart[],
    target: Pick<import('../domain/types.js').SiteBackupSettings, 's3Endpoint' | 's3Bucket' | 's3Region'>,
    credentials: { accessKeyId: string; secretAccessKey: string },
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
  domainIngress?: DomainIngress;
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
    try {
      const recovered = await this.deps.store.recoverStaleJobs(
        this.now(),
        this.deps.config.PROVISION_LOCK_TIMEOUT_MS,
      );
      this.logger.info({ recovered }, 'startup job recovery completed');
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'startup job recovery failed; normal polling will continue',
      );
    }
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
    if (job.type === 'credentials') return this.processCredentialJob(job, instance);
    if (job.type === 'domain') return this.processCustomDomainJob(job, instance);

    if (instance.status === 'ready') {
      await this.deps.store.completeJob(job.id);
      return 'ready';
    }

    const log = { jobId: job.id, instanceId: instance.id, hostname: instance.hostname, attempt: job.attempts };
    this.logger.info(log, 'provisioning instance');
    if (!job.lockedAt || !(await this.isJobRunning(job))) return 'skipped';
    const claim = { attempts: job.attempts, lockedAt: job.lockedAt };

    try {
      // On a retry, remove whatever a previous attempt may have left behind so
      // `bench new-site` starts clean. Best-effort: a missing site is fine.
      if (job.attempts > 1 || job.cleanupBeforeRun) {
        await this.safeDrop(instance);
      }

      await this.setStatus(instance, 'provisioning');
      if (!(await this.isJobRunning(job))) return 'skipped';
      const encryptedCredentials = await this.deps.store.findInstanceCredentials(instance.id);
      const adminPassword = encryptedCredentials?.adminPasswordCiphertext
        ? decryptCredential(
            encryptedCredentials.adminPasswordCiphertext,
            this.deps.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
          )
        : this.deps.config.ERPNEXT_ADMIN_PASSWORD;
      await this.deps.bench.newSite(instance.siteName, adminPassword);
      if (!(await this.isJobRunning(job))) return 'skipped';

      await this.setStatus(instance, 'installing');
      if (!(await this.isJobRunning(job))) return 'skipped';
      await this.deps.bench.ensureAppInstalled(instance.siteName, 'erpnext');
      if (!(await this.isJobRunning(job))) return 'skipped';

      await this.setStatus(instance, 'configuring');
      if (!(await this.isJobRunning(job))) return 'skipped';
      await this.deps.bench.setHostname(instance.siteName, instance.hostname);
      if (!(await this.isJobRunning(job))) return 'skipped';
      await this.configureRouting(log, instance);
      if (!(await this.isJobRunning(job))) return 'skipped';

      await this.deps.health.waitForHealthy(instance.hostname);

      if (!(await this.deps.store.completeProvisioningJob(job.id, instance.id, claim))) return 'skipped';
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
      if (!(await this.isJobRunning(job))) return 'skipped';
      return this.handleFailure(job, instance, err);
    }
  }

  private async processCredentialJob(
    job: ProvisioningJob,
    instance: Instance,
  ): Promise<JobOutcome> {
    if (!job.lockedAt || !(await this.isJobRunning(job))) return 'skipped';
    const claim = { attempts: job.attempts, lockedAt: job.lockedAt };
    const log = { jobId: job.id, instanceId: instance.id, hostname: instance.hostname, attempt: job.attempts };
    try {
      const credentials = await this.deps.store.findInstanceCredentials(instance.id);
      if (!credentials?.pendingAdminPasswordCiphertext) {
        throw new Error('Pending Administrator password was not found');
      }
      const password = decryptCredential(
        credentials.pendingAdminPasswordCiphertext,
        this.deps.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
      );
      await this.deps.bench.setAdminPassword(instance.siteName, password);
      if (!(await this.isJobRunning(job))) return 'skipped';
      const completed = await this.deps.store.completeInstanceCredentialChange(
        job.id,
        instance.id,
        claim,
      );
      if (!completed) return 'skipped';
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: 'instance.credentials_changed',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { hostname: instance.hostname },
      });
      this.logger.info(log, 'instance Administrator password changed');
      return 'ready';
    } catch (err) {
      if (!(await this.isJobRunning(job))) return 'skipped';
      const message = this.sanitizeError(err);
      const exhausted = job.attempts >= job.maxAttempts;
      this.logger.error(
        { ...log, error: message },
        'instance Administrator password change failed',
      );
      const recorded = await this.deps.store.recordInstanceCredentialChangeFailure(
        job.id,
        instance.id,
        claim,
        exhausted,
        new Date(this.now().getTime() + computeBackoffMs(job.attempts)),
        message,
      );
      if (!recorded) return 'skipped';
      return exhausted ? 'failed' : 'retry';
    }
  }

  private async processCustomDomainJob(
    job: ProvisioningJob,
    instance: Instance,
  ): Promise<JobOutcome> {
    if (!job.lockedAt || !(await this.isJobRunning(job))) return 'skipped';
    const isRemoval = instance.customDomainStatus === 'removing';
    const domain = instance.customDomain;
    const log = { jobId: job.id, instanceId: instance.id, hostname: instance.hostname, domain, attempt: job.attempts };
    try {
      if (!this.deps.domainIngress) {
        throw new Error('Custom-domain ingress is not configured; enable the Traefik file-provider integration');
      }
      if (!domain || (!isRemoval && instance.customDomainStatus !== 'configuring')) {
        throw new Error('Custom domain operation is missing its pending domain');
      }
      if (isRemoval) {
        await this.deps.domainIngress.remove(domain);
        await this.deps.bench.removeDomain(instance.siteName, domain);
        if (!(await this.isJobRunning(job))) return 'skipped';
      } else {
        await this.deps.bench.addDomain(instance.siteName, domain);
        await this.deps.health.waitForHealthy(domain);
        if (!(await this.isJobRunning(job))) return 'skipped';
        await this.deps.domainIngress.configure(domain);
      }
      if (!(await this.isJobRunning(job))) return 'skipped';
      if (isRemoval) await this.deps.health.waitForHealthy(instance.hostname);
      const completed = await this.deps.store.completeCustomDomainJob(
        job.id,
        instance.id,
        { attempts: job.attempts, lockedAt: job.lockedAt },
        isRemoval,
      );
      if (!completed) return 'skipped';
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: isRemoval ? 'instance.custom_domain_removed' : 'instance.custom_domain_configured',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { domain },
      });
      this.logger.info(log, isRemoval ? 'custom domain removed' : 'custom domain configured');
      return 'ready';
    } catch (err) {
      if (!(await this.isJobRunning(job))) return 'skipped';
      const message = this.sanitizeError(err);
      const exhausted = job.attempts >= job.maxAttempts;
      this.logger.error({ ...log, error: message }, 'custom domain operation failed');
      const recorded = await this.deps.store.recordCustomDomainFailure(
        job.id,
        instance.id,
        { attempts: job.attempts, lockedAt: job.lockedAt },
        exhausted,
        new Date(this.now().getTime() + computeBackoffMs(job.attempts)),
        message,
      );
      if (!recorded) return 'skipped';
      return exhausted ? 'failed' : 'retry';
    }
  }

  private async isJobRunning(job: ProvisioningJob): Promise<boolean> {
    if (!job.lockedAt) return false;
    const current = await this.deps.store.findJobById(job.id);
    return current?.status === 'running' &&
      current.attempts === job.attempts &&
      current.lockedAt?.getTime() === job.lockedAt.getTime();
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
      const encryptedCredentials = await this.deps.store.getSiteBackupCredentials();
      if (!encryptedCredentials) {
        throw new Error('S3 backup target is configured without saved credentials');
      }
      const credentials = {
        accessKeyId: decryptCredential(
          encryptedCredentials.accessKeyCiphertext,
          this.deps.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
        ),
        secretAccessKey: decryptCredential(
          encryptedCredentials.secretKeyCiphertext,
          this.deps.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
        ),
      };
      return {
        parts: await this.deps.bench.uploadBackup(siteName, backupId, parts, settings, credentials),
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
    if (!job.lockedAt) return 'skipped';
    const claim = { attempts: job.attempts, lockedAt: job.lockedAt };
    const message = this.sanitizeError(err);
    const exhausted = job.attempts >= job.maxAttempts;

    this.logger.error(
      { jobId: job.id, instanceId: instance.id, attempt: job.attempts, error: message },
      'provisioning attempt failed',
    );

    await this.safeDrop(instance);

    const recorded = await this.deps.store.recordProvisioningFailure(
      job.id,
      instance.id,
      claim,
      exhausted,
      new Date(this.now().getTime() + computeBackoffMs(job.attempts)),
      message,
    );
    if (!recorded) return 'skipped';

    if (exhausted) {
      await this.deps.store.recordAudit({
        actorUserId: null,
        action: 'instance.failed',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { attempts: job.attempts, error: message },
      });
      return 'failed';
    }

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
