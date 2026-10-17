import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, ProvisioningJob } from '../domain/types.js';
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

export type JobOutcome = 'ready' | 'retry' | 'failed' | 'skipped';

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
