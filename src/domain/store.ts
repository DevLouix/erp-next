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

/**
 * The persistence boundary.
 *
 * The application depends only on this interface, which lets tests run against
 * an in-memory implementation while production uses PostgreSQL via Prisma.
 *
 * `claimNextJob` is the one method with concurrency semantics: it must claim a
 * single due job atomically and safely even when several workers run at once.
 */
export interface Store {
  // Users
  findUserByOauthSubject(oauthSubject: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(input: {
    oauthSubject: string;
    email: string;
    name: string | null;
    role: UserRole;
  }): Promise<User>;
  updateUser(
    id: string,
    patch: Partial<{ email: string; name: string | null; role: UserRole; disabled: boolean }>,
  ): Promise<User>;
  listUsers(): Promise<User[]>;
  countUsers(): Promise<number>;

  // Instances
  createInstance(input: CreateInstanceInput): Promise<Instance>;
  findInstanceById(id: string): Promise<Instance | null>;
  findInstanceByOwnerAndIdempotencyKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<Instance | null>;
  findInstanceBySiteName(siteName: string): Promise<Instance | null>;
  findInstanceByHostname(hostname: string): Promise<Instance | null>;
  listInstancesByOwner(ownerUserId: string): Promise<Instance[]>;
  listAllInstances(): Promise<Instance[]>;
  updateInstance(
    id: string,
    patch: Partial<{ companyName: string; status: InstanceStatus; errorMessage: string | null }>,
  ): Promise<Instance>;
  queueInstanceDeletion(instanceId: string, maxAttempts: number): Promise<ProvisioningJob>;
  stopProvisioning(instanceId: string, error: string): Promise<boolean>;
  deleteInstance(id: string): Promise<void>;
  queueSiteBackup(instance: Instance, actorUserId: string, maxAttempts: number): Promise<SiteBackup>;
  createSiteBackupRecord(
    siteName: string,
    hostname: string,
    actorUserId: string | null,
  ): Promise<SiteBackup>;
  updateSiteBackup(
    id: string,
    patch: Partial<{
      status: SiteBackup['status'];
      parts: SiteBackupPart[];
      errorMessage: string | null;
      completedAt: Date | null;
    }>,
  ): Promise<SiteBackup>;
  findSiteBackup(id: string): Promise<SiteBackup | null>;
  listSiteBackups(siteName: string): Promise<SiteBackup[]>;
  listSiteBackupsByOwner(ownerUserId: string): Promise<SiteBackup[]>;
  listAllSiteBackups(): Promise<SiteBackup[]>;
  getSiteBackupSettings(): Promise<SiteBackupSettings>;
  updateSiteBackupSettings(
    settings: Pick<
      SiteBackupSettings,
      'automaticEnabled' | 'intervalHours' | 's3Endpoint' | 's3Bucket' | 's3Region'
    >,
    now: Date,
    credentials?: EncryptedSiteBackupCredentials | null,
  ): Promise<SiteBackupSettings>;
  getSiteBackupCredentials(): Promise<EncryptedSiteBackupCredentials | null>;
  queueScheduledSiteBackups(now: Date, maxAttempts: number): Promise<number>;
  /** Create or update an instance by its (unique) site name — used by restore. */
  importInstance(input: ImportInstanceInput): Promise<Instance>;

  // Provisioning jobs
  createJob(input: CreateJobInput): Promise<ProvisioningJob>;
  claimNextJob(now: Date): Promise<ProvisioningJob | null>;
  recoverStaleJobs(now: Date, lockTimeoutMs: number): Promise<number>;
  completeProvisioningJob(
    jobId: string,
    instanceId: string,
    claim: { attempts: number; lockedAt: Date },
  ): Promise<boolean>;
  recordProvisioningFailure(
    jobId: string,
    instanceId: string,
    claim: { attempts: number; lockedAt: Date },
    exhausted: boolean,
    nextRunAt: Date,
    error: string,
  ): Promise<boolean>;
  completeJob(id: string): Promise<ProvisioningJob>;
  rescheduleJob(id: string, nextRunAt: Date, error: string | null): Promise<ProvisioningJob>;
  failJob(id: string, error: string): Promise<ProvisioningJob>;
  findJobById(id: string): Promise<ProvisioningJob | null>;
  findLatestJobForInstance(instanceId: string): Promise<ProvisioningJob | null>;
  listAllJobs(): Promise<ProvisioningJob[]>;
  resetJobForRetry(instanceId: string, maxAttempts: number): Promise<ProvisioningJob>;

  // Sessions
  createSession(input: {
    tokenHash: string;
    userId: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date;
  }): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  updateSessionTokens(
    id: string,
    tokens: { accessToken: string | null; refreshToken: string | null; expiresAt: Date },
  ): Promise<void>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsByUser(userId: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<number>;

  // OAuth transactions
  createOAuthTransaction(tx: OAuthTransaction): Promise<void>;
  consumeOAuthTransaction(state: string, now: Date): Promise<OAuthTransaction | null>;
  deleteExpiredOAuthTransactions(now: Date): Promise<number>;

  // Audit
  recordAudit(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void>;
  listAudit(limit: number): Promise<AuditLogEntry[]>;

  // Backups
  createBackup(input: {
    label: string | null;
    createdByUserId: string | null;
    schemaVersion: number;
    counts: Record<string, number>;
    payload: PlatformSnapshot;
  }): Promise<BackupSnapshotMeta>;
  listBackups(): Promise<BackupSnapshotMeta[]>;
  findBackupById(id: string): Promise<BackupSnapshot | null>;
  deleteBackup(id: string): Promise<void>;
}
