/**
 * Platform domain types.
 *
 * These describe PLATFORM metadata only. ERPNext business data never appears
 * here — it stays inside each site's own database.
 */

export const INSTANCE_STATUSES = [
  'queued',
  'provisioning',
  'installing',
  'configuring',
  'deleting',
  'ready',
  'failed',
] as const;

export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobType = 'provision' | 'delete' | 'backup' | 'credentials';

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface User {
  id: string;
  oauthSubject: string;
  email: string;
  name: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Instance {
  id: string;
  ownerUserId: string;
  companyName: string;
  siteName: string;
  hostname: string;
  status: InstanceStatus;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProvisioningJob {
  id: string;
  instanceId: string;
  type: JobType;
  siteBackupId: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
  cleanupBeforeRun: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface OAuthTransaction {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateInstanceInput {
  ownerUserId: string;
  companyName: string;
  siteName: string;
  hostname: string;
  adminPasswordCiphertext: string;
  idempotencyKey: string | null;
  maxAttempts: number;
}

export interface EncryptedInstanceCredentials {
  adminPasswordCiphertext: string | null;
  pendingAdminPasswordCiphertext: string | null;
}

export interface CreateJobInput {
  instanceId: string;
  maxAttempts: number;
  type?: JobType;
  siteBackupId?: string | null;
}

export interface ImportInstanceInput {
  ownerUserId: string;
  companyName: string;
  siteName: string;
  hostname: string;
  status: InstanceStatus;
  errorMessage: string | null;
  adminPasswordCiphertext?: string | null;
}

export type SiteBackupStatus = 'queued' | 'running' | 'completed' | 'failed';
export type SiteBackupPartKind =
  | 'database'
  | 'public-files'
  | 'private-files'
  | 'site-config';

export interface SiteBackupPart {
  kind: SiteBackupPartKind;
  relativePath: string;
  sizeBytes: number;
  s3ObjectKey?: string;
}

export interface SiteBackup {
  id: string;
  siteName: string;
  hostname: string;
  status: SiteBackupStatus;
  parts: SiteBackupPart[];
  createdByUserId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface SiteBackupSettings {
  automaticEnabled: boolean;
  intervalHours: number;
  nextRunAt: Date | null;
  s3Endpoint: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  s3CredentialsConfigured: boolean;
  updatedAt: Date;
}

export interface EncryptedSiteBackupCredentials {
  accessKeyCiphertext: string;
  secretKeyCiphertext: string;
}

// ── Backups ────────────────────────────────────────────────────────────────

export const BACKUP_SCHEMA_VERSION = 3;

export interface SnapshotUser {
  id: string;
  oauthSubject: string;
  email: string;
  name: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

export interface SnapshotInstance {
  id: string;
  ownerUserId: string;
  companyName: string;
  siteName: string;
  hostname: string;
  status: InstanceStatus;
  errorMessage: string | null;
  adminPasswordCiphertext?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotJob {
  id: string;
  instanceId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  lastError: string | null;
}

/**
 * A portable snapshot of platform state. It includes encrypted instance
 * password ciphertext for login recovery, but excludes sessions, OAuth
 * transactions and tokens so restores cannot impersonate a live session.
 */
export interface PlatformSnapshot {
  app: 'erp-next-platform';
  schemaVersion: number;
  exportedAt: string;
  users: SnapshotUser[];
  instances: SnapshotInstance[];
  jobs: SnapshotJob[];
}

export interface BackupSnapshotMeta {
  id: string;
  label: string | null;
  schemaVersion: number;
  createdByUserId: string | null;
  counts: Record<string, number>;
  createdAt: Date;
}

export interface BackupSnapshot extends BackupSnapshotMeta {
  payload: PlatformSnapshot;
}

export interface ImportOptions {
  dryRun: boolean;
  baseDomainOverride?: string | null;
}
