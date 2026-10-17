import { randomUUID } from 'node:crypto';
import type {
  AuditLogEntry,
  EncryptedSiteBackupCredentials,
  BackupSnapshot,
  BackupSnapshotMeta,
  CreateInstanceInput,
  CreateJobInput,
  ImportInstanceInput,
  Instance,
  InstanceStatus,
  OAuthTransaction,
  PlatformSnapshot,
  ProvisioningJob,
  SiteBackup,
  SiteBackupPart,
  SiteBackupSettings,
  Session,
  User,
  UserRole,
} from './types.js';
import type { Store } from './store.js';
import { DuplicateError } from './errors.js';

interface UserPatch {
  email?: string;
  name?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

interface InstancePatch {
  companyName?: string;
  status?: InstanceStatus;
  errorMessage?: string | null;
}

/**
 * In-memory Store used by tests. Mirrors the PostgreSQL semantics closely,
 * including one-job-per-instance and atomic claiming.
 */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private instances = new Map<string, Instance>();
  private jobs = new Map<string, ProvisioningJob>();
  private siteBackups = new Map<string, SiteBackup>();
  private siteBackupSettings: SiteBackupSettings = {
    automaticEnabled: false,
    intervalHours: 24,
    nextRunAt: null,
    s3Endpoint: null,
    s3Bucket: null,
    s3Region: null,
    s3CredentialsConfigured: false,
    updatedAt: new Date(0),
  };
  private siteBackupCredentials: EncryptedSiteBackupCredentials | null = null;
  private sessions = new Map<string, Session>();
  private oauthTransactions = new Map<string, OAuthTransaction>();
  private audits: AuditLogEntry[] = [];
  private backups: BackupSnapshot[] = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString().padStart(4, '0')}`;
  }

  async findUserByOauthSubject(oauthSubject: string): Promise<User | null> {
    for (const u of this.users.values()) if (u.oauthSubject === oauthSubject) return u;
    return null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: {
    oauthSubject: string;
    email: string;
    name: string | null;
    role: UserRole;
  }): Promise<User> {
    const now = new Date();
    const user: User = {
      id: this.nextId('usr'),
      oauthSubject: input.oauthSubject,
      email: input.email,
      name: input.name,
      role: input.role,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(id: string, patch: UserPatch): Promise<User> {
    const user = this.users.get(id);
    if (!user) throw new Error(`User not found: ${id}`);
    const updated: User = { ...user, ...patch, updatedAt: new Date() };
    this.users.set(id, updated);
    return updated;
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    for (const existing of this.instances.values()) {
      if (existing.siteName === input.siteName) throw new DuplicateError('site_name', input.siteName);
      if (existing.hostname === input.hostname) throw new DuplicateError('hostname', input.hostname);
      if (
        input.idempotencyKey &&
        existing.ownerUserId === input.ownerUserId &&
        existing.idempotencyKey === input.idempotencyKey
      ) {
        throw new DuplicateError('idempotency_key', input.idempotencyKey);
      }
    }
    const now = new Date();
    const instance: Instance = {
      id: this.nextId('ins'),
      ownerUserId: input.ownerUserId,
      companyName: input.companyName,
      siteName: input.siteName,
      hostname: input.hostname,
      status: 'queued',
      errorMessage: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(instance.id, instance);
    return instance;
  }

  async findInstanceById(id: string): Promise<Instance | null> {
    return this.instances.get(id) ?? null;
  }

  async findInstanceByOwnerAndIdempotencyKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<Instance | null> {
    for (const i of this.instances.values()) {
      if (i.ownerUserId === ownerUserId && i.idempotencyKey === idempotencyKey) return i;
    }
    return null;
  }

  async findInstanceBySiteName(siteName: string): Promise<Instance | null> {
    for (const i of this.instances.values()) if (i.siteName === siteName) return i;
    return null;
  }

  async findInstanceByHostname(hostname: string): Promise<Instance | null> {
    for (const i of this.instances.values()) if (i.hostname === hostname) return i;
    return null;
  }

  async listInstancesByOwner(ownerUserId: string): Promise<Instance[]> {
    return [...this.instances.values()]
      .filter((i) => i.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listAllInstances(): Promise<Instance[]> {
    return [...this.instances.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async updateInstance(id: string, patch: InstancePatch): Promise<Instance> {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    const updated: Instance = { ...instance, ...patch, updatedAt: new Date() };
    this.instances.set(id, updated);
    return updated;
  }

  async queueInstanceDeletion(instanceId: string, maxAttempts: number): Promise<ProvisioningJob> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);
    const latest = await this.findLatestJobForInstance(instanceId);
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      throw new DuplicateError('active_job_for_instance', instanceId);
    }
    const now = new Date();
    const job: ProvisioningJob = latest
      ? {
          ...latest,
          type: 'delete',
        siteBackupId: null,
          status: 'queued',
          attempts: 0,
          maxAttempts,
          nextRunAt: now,
          lockedAt: null,
          lastError: null,
          updatedAt: now,
        }
      : {
          id: this.nextId('job'),
          instanceId,
          type: 'delete',
          siteBackupId: null,
          status: 'queued',
          attempts: 0,
          maxAttempts,
          nextRunAt: now,
          lockedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        };
    this.jobs.set(job.id, job);
    this.instances.set(instanceId, { ...instance, status: 'deleting', errorMessage: null, updatedAt: now });
    return job;
  }

  async deleteInstance(id: string): Promise<void> {
    this.instances.delete(id);
    for (const [jobId, job] of this.jobs) {
      if (job.instanceId === id) this.jobs.delete(jobId);
    }
  }

  async queueSiteBackup(
    instance: Instance,
    actorUserId: string,
    maxAttempts: number,
  ): Promise<SiteBackup> {
    const activeJob = await this.findLatestJobForInstance(instance.id);
    if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'running')) {
      throw new DuplicateError('active_job_for_instance', instance.id);
    }
    const backup = await this.createSiteBackupRecord(instance.siteName, instance.hostname, actorUserId);
    await this.createJob({
      instanceId: instance.id,
      maxAttempts,
      type: 'backup',
      siteBackupId: backup.id,
    });
    return backup;
  }

  async createSiteBackupRecord(
    siteName: string,
    hostname: string,
    actorUserId: string | null,
  ): Promise<SiteBackup> {
    const backup: SiteBackup = {
      id: this.nextId('sitebak'),
      siteName,
      hostname,
      status: 'queued',
      parts: [],
      createdByUserId: actorUserId,
      errorMessage: null,
      createdAt: new Date(),
      completedAt: null,
    };
    this.siteBackups.set(backup.id, backup);
    return backup;
  }

  async updateSiteBackup(
    id: string,
    patch: Partial<{
      status: SiteBackup['status'];
      parts: SiteBackupPart[];
      errorMessage: string | null;
      completedAt: Date | null;
    }>,
  ): Promise<SiteBackup> {
    const backup = this.siteBackups.get(id);
    if (!backup) throw new Error(`Site backup not found: ${id}`);
    const updated = { ...backup, ...patch };
    this.siteBackups.set(id, updated);
    return updated;
  }

  async findSiteBackup(id: string): Promise<SiteBackup | null> {
    return this.siteBackups.get(id) ?? null;
  }

  async listSiteBackups(siteName: string): Promise<SiteBackup[]> {
    return [...this.siteBackups.values()]
      .filter((backup) => backup.siteName === siteName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listSiteBackupsByOwner(ownerUserId: string): Promise<SiteBackup[]> {
    return [...this.siteBackups.values()]
      .filter((backup) => backup.createdByUserId === ownerUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listAllSiteBackups(): Promise<SiteBackup[]> {
    return [...this.siteBackups.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async getSiteBackupSettings(): Promise<SiteBackupSettings> {
    return {
      ...this.siteBackupSettings,
      s3CredentialsConfigured: this.siteBackupCredentials !== null,
    };
  }

  async updateSiteBackupSettings(
    settings: Pick<
      SiteBackupSettings,
      'automaticEnabled' | 'intervalHours' | 's3Endpoint' | 's3Bucket' | 's3Region'
    >,
    now: Date,
    credentials?: EncryptedSiteBackupCredentials | null,
  ): Promise<SiteBackupSettings> {
    if (credentials !== undefined) this.siteBackupCredentials = credentials;
    this.siteBackupSettings = {
      ...settings,
      s3CredentialsConfigured: this.siteBackupCredentials !== null,
      nextRunAt: settings.automaticEnabled
        ? new Date(now.getTime() + settings.intervalHours * 60 * 60 * 1000)
        : null,
      updatedAt: now,
    };
    return this.siteBackupSettings;
  }

  async getSiteBackupCredentials(): Promise<EncryptedSiteBackupCredentials | null> {
    return this.siteBackupCredentials ? { ...this.siteBackupCredentials } : null;
  }

  async queueScheduledSiteBackups(now: Date, maxAttempts: number): Promise<number> {
    const settings = this.siteBackupSettings;
    if (!settings.automaticEnabled || !settings.nextRunAt || settings.nextRunAt > now) return 0;
    this.siteBackupSettings = {
      ...settings,
      nextRunAt: new Date(now.getTime() + settings.intervalHours * 60 * 60 * 1000),
      updatedAt: now,
    };
    let queued = 0;
    for (const instance of this.instances.values()) {
      if (instance.status !== 'ready') continue;
      const latest = await this.findLatestJobForInstance(instance.id);
      if (latest && (latest.status === 'queued' || latest.status === 'running')) continue;
      const backup = await this.createSiteBackupRecord(
        instance.siteName,
        instance.hostname,
        instance.ownerUserId,
      );
      await this.createJob({
        instanceId: instance.id,
        maxAttempts,
        type: 'backup',
        siteBackupId: backup.id,
      });
      queued += 1;
    }
    return queued;
  }

  async importInstance(input: ImportInstanceInput): Promise<Instance> {
    const existing = await this.findInstanceBySiteName(input.siteName);
    if (existing) {
      const updated: Instance = {
        ...existing,
        ownerUserId: input.ownerUserId,
        companyName: input.companyName,
        hostname: input.hostname,
        status: input.status,
        errorMessage: input.errorMessage,
        updatedAt: new Date(),
      };
      this.instances.set(existing.id, updated);
      return updated;
    }
    const now = new Date();
    const instance: Instance = {
      id: this.nextId('ins'),
      ownerUserId: input.ownerUserId,
      companyName: input.companyName,
      siteName: input.siteName,
      hostname: input.hostname,
      status: input.status,
      errorMessage: input.errorMessage,
      idempotencyKey: null,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(instance.id, instance);
    return instance;
  }

  async createJob(input: CreateJobInput): Promise<ProvisioningJob> {
    for (const job of this.jobs.values()) {
      if (job.instanceId === input.instanceId && job.status !== 'succeeded') {
        throw new DuplicateError('active_job_for_instance', input.instanceId);
      }
    }
    const now = new Date();
    const job: ProvisioningJob = {
      id: this.nextId('job'),
      instanceId: input.instanceId,
      type: input.type ?? 'provision',
      siteBackupId: input.siteBackupId ?? null,
      status: 'queued',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      nextRunAt: now,
      lockedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claimNextJob(now: Date): Promise<ProvisioningJob | null> {
    const candidates = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && j.nextRunAt.getTime() <= now.getTime())
      .sort(
        (a, b) =>
          a.nextRunAt.getTime() - b.nextRunAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
      );
    const job = candidates[0];
    if (!job) return null;
    const claimed: ProvisioningJob = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      lockedAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, claimed);
    return claimed;
  }

  async recoverStaleJobs(now: Date, lockTimeoutMs: number): Promise<number> {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || !job.lockedAt) continue;
      if (now.getTime() - job.lockedAt.getTime() < lockTimeoutMs) continue;
      if (job.attempts >= job.maxAttempts) {
        this.jobs.set(job.id, {
          ...job,
          status: 'failed',
          lockedAt: null,
          lastError: 'Provisioning timed out and exceeded the retry limit',
          updatedAt: now,
        });
      } else {
        this.jobs.set(job.id, {
          ...job,
          status: 'queued',
          lockedAt: null,
          nextRunAt: now,
          lastError: 'Provisioning timed out; retrying',
          updatedAt: now,
        });
      }
      recovered += 1;
    }
    return recovered;
  }

  async completeJob(id: string): Promise<ProvisioningJob> {
    return this.patchJob(id, { status: 'succeeded', lockedAt: null, lastError: null });
  }

  async rescheduleJob(id: string, nextRunAt: Date, error: string | null): Promise<ProvisioningJob> {
    return this.patchJob(id, { status: 'queued', lockedAt: null, nextRunAt, lastError: error });
  }

  async failJob(id: string, error: string): Promise<ProvisioningJob> {
    return this.patchJob(id, { status: 'failed', lockedAt: null, lastError: error });
  }

  private async patchJob(id: string, patch: Partial<ProvisioningJob>): Promise<ProvisioningJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const updated = { ...job, ...patch, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  async findJobById(id: string): Promise<ProvisioningJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async findLatestJobForInstance(instanceId: string): Promise<ProvisioningJob | null> {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.instanceId === instanceId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
    return jobs[0] ?? null;
  }

  async listAllJobs(): Promise<ProvisioningJob[]> {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async resetJobForRetry(instanceId: string, maxAttempts: number): Promise<ProvisioningJob> {
    const latest = await this.findLatestJobForInstance(instanceId);
    const now = new Date();
    if (!latest) {
      return this.createJob({ instanceId, maxAttempts });
    }
    return this.patchJob(latest.id, {
      status: 'queued',
      type: 'provision',
      siteBackupId: null,
      attempts: 0,
      maxAttempts,
      nextRunAt: now,
      lockedAt: null,
      lastError: null,
    });
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date;
  }): Promise<Session> {
    const session: Session = {
      id: this.nextId('ses'),
      tokenHash: input.tokenHash,
      userId: input.userId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    for (const s of this.sessions.values()) if (s.tokenHash === tokenHash) return s;
    return null;
  }

  async updateSessionTokens(
    id: string,
    tokens: { accessToken: string | null; refreshToken: string | null; expiresAt: Date },
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, ...tokens });
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteSessionsByUser(userId: string): Promise<void> {
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt.getTime() <= now.getTime()) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    return n;
  }

  async createOAuthTransaction(tx: OAuthTransaction): Promise<void> {
    this.oauthTransactions.set(tx.state, tx);
  }

  async consumeOAuthTransaction(state: string, now: Date): Promise<OAuthTransaction | null> {
    const tx = this.oauthTransactions.get(state);
    if (!tx) return null;
    this.oauthTransactions.delete(state);
    if (tx.expiresAt.getTime() <= now.getTime()) return null;
    return tx;
  }

  async deleteExpiredOAuthTransactions(now: Date): Promise<number> {
    let n = 0;
    for (const [state, tx] of this.oauthTransactions) {
      if (tx.expiresAt.getTime() <= now.getTime()) {
        this.oauthTransactions.delete(state);
        n += 1;
      }
    }
    return n;
  }

  async recordAudit(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    this.audits.push({ ...entry, id: this.nextId('aud'), createdAt: new Date() });
  }

  async listAudit(limit: number): Promise<AuditLogEntry[]> {
    return this.audits.slice(-limit).reverse();
  }

  async createBackup(input: {
    label: string | null;
    createdByUserId: string | null;
    schemaVersion: number;
    counts: Record<string, number>;
    payload: PlatformSnapshot;
  }): Promise<BackupSnapshotMeta> {
    const snapshot: BackupSnapshot = {
      id: this.nextId('bak'),
      label: input.label,
      schemaVersion: input.schemaVersion,
      createdByUserId: input.createdByUserId,
      counts: input.counts,
      payload: input.payload,
      createdAt: new Date(),
    };
    this.backups.push(snapshot);
    const { payload: _payload, ...meta } = snapshot;
    return meta;
  }

  async listBackups(): Promise<BackupSnapshotMeta[]> {
    return [...this.backups]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ payload: _payload, ...meta }) => meta);
  }

  async findBackupById(id: string): Promise<BackupSnapshot | null> {
    return this.backups.find((b) => b.id === id) ?? null;
  }

  async deleteBackup(id: string): Promise<void> {
    this.backups = this.backups.filter((b) => b.id !== id);
  }
}
