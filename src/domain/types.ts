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
  'ready',
  'failed',
] as const;

export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

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
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
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
  siteName: string;
  hostname: string;
  idempotencyKey: string | null;
  maxAttempts: number;
}

export interface CreateJobInput {
  instanceId: string;
  maxAttempts: number;
}

export interface ImportInstanceInput {
  ownerUserId: string;
  siteName: string;
  hostname: string;
  status: InstanceStatus;
  errorMessage: string | null;
}

// ── Backups ────────────────────────────────────────────────────────────────

export const BACKUP_SCHEMA_VERSION = 1;

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
  siteName: string;
  hostname: string;
  status: InstanceStatus;
  errorMessage: string | null;
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
 * A portable snapshot of platform state. Deliberately excludes sessions,
 * OAuth transactions and any tokens: restoring a backup never restores the
 * ability to impersonate a live session.
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
