import { Prisma, type PrismaClient } from '@prisma/client';
import type { Store } from './store.js';
import { DuplicateError } from './errors.js';
import type {
  AuditLogEntry,
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
  Session,
  User,
  UserRole,
} from './types.js';

function toUser(row: {
  id: string;
  oauthSubject: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): User {
  return { ...row, role: row.role as UserRole };
}

function toInstance(row: {
  id: string;
  ownerUserId: string;
  siteName: string;
  hostname: string;
  status: string;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Instance {
  return { ...row, status: row.status as InstanceStatus };
}

function toJob(row: {
  id: string;
  instanceId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ProvisioningJob {
  return { ...row, status: row.status as ProvisioningJob['status'] };
}

function toSession(row: {
  id: string;
  tokenHash: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date;
  createdAt: Date;
}): Session {
  return row;
}

function toBackupMeta(row: {
  id: string;
  label: string | null;
  schemaVersion: number;
  createdByUserId: string | null;
  counts: unknown;
  createdAt: Date;
}): BackupSnapshotMeta {
  return {
    id: row.id,
    label: row.label,
    schemaVersion: row.schemaVersion,
    createdByUserId: row.createdByUserId,
    counts: (row.counts as Record<string, number> | null) ?? {},
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByOauthSubject(oauthSubject: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { oauthSubject } });
    return row ? toUser(row) : null;
  }

  async findUserById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async createUser(input: {
    oauthSubject: string;
    email: string;
    name: string | null;
    role: UserRole;
  }): Promise<User> {
    try {
      const row = await this.prisma.user.create({ data: input });
      return toUser(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateError('oauth_subject', input.oauthSubject);
      throw err;
    }
  }

  async updateUser(
    id: string,
    patch: Partial<{ email: string; name: string | null; role: UserRole; disabled: boolean }>,
  ): Promise<User> {
    const row = await this.prisma.user.update({ where: { id }, data: patch });
    return toUser(row);
  }

  async listUsers(): Promise<User[]> {
    const rows = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toUser);
  }

  async countUsers(): Promise<number> {
    return this.prisma.user.count();
  }

  async createInstance(input: CreateInstanceInput): Promise<Instance> {
    try {
      const row = await this.prisma.instance.create({
        data: {
          ownerUserId: input.ownerUserId,
          siteName: input.siteName,
          hostname: input.hostname,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return toInstance(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const target = (err as { meta?: { target?: string[] } }).meta?.target ?? [];
        const field = target.find((t) => t.includes('hostname'))
          ? 'hostname'
          : target.find((t) => t.includes('idempotency'))
            ? 'idempotency_key'
            : 'site_name';
        throw new DuplicateError(field, field === 'hostname' ? input.hostname : input.siteName);
      }
      throw err;
    }
  }

  async findInstanceById(id: string): Promise<Instance | null> {
    const row = await this.prisma.instance.findUnique({ where: { id } });
    return row ? toInstance(row) : null;
  }

  async findInstanceByOwnerAndIdempotencyKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<Instance | null> {
    const row = await this.prisma.instance.findUnique({
      where: { owner_idempotency_key: { ownerUserId, idempotencyKey } },
    });
    return row ? toInstance(row) : null;
  }

  async findInstanceBySiteName(siteName: string): Promise<Instance | null> {
    const row = await this.prisma.instance.findUnique({ where: { siteName } });
    return row ? toInstance(row) : null;
  }

  async findInstanceByHostname(hostname: string): Promise<Instance | null> {
    const row = await this.prisma.instance.findUnique({ where: { hostname } });
    return row ? toInstance(row) : null;
  }

  async listInstancesByOwner(ownerUserId: string): Promise<Instance[]> {
    const rows = await this.prisma.instance.findMany({
      where: { ownerUserId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toInstance);
  }

  async listAllInstances(): Promise<Instance[]> {
    const rows = await this.prisma.instance.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toInstance);
  }

  async updateInstance(
    id: string,
    patch: Partial<{ status: InstanceStatus; errorMessage: string | null }>,
  ): Promise<Instance> {
    const row = await this.prisma.instance.update({ where: { id }, data: patch });
    return toInstance(row);
  }

  async importInstance(input: ImportInstanceInput): Promise<Instance> {
    const row = await this.prisma.instance.upsert({
      where: { siteName: input.siteName },
      create: {
        ownerUserId: input.ownerUserId,
        siteName: input.siteName,
        hostname: input.hostname,
        status: input.status,
        errorMessage: input.errorMessage,
      },
      update: {
        ownerUserId: input.ownerUserId,
        hostname: input.hostname,
        status: input.status,
        errorMessage: input.errorMessage,
      },
    });
    return toInstance(row);
  }

  async createJob(input: CreateJobInput): Promise<ProvisioningJob> {
    const row = await this.prisma.provisioningJob.create({
      data: { instanceId: input.instanceId, maxAttempts: input.maxAttempts },
    });
    return toJob(row);
  }

  async claimNextJob(now: Date): Promise<ProvisioningJob | null> {
    // Atomically claim one due job. FOR UPDATE SKIP LOCKED lets multiple
    // workers run safely without blocking or double-processing.
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM provisioning_jobs
        WHERE status = 'queued' AND next_run_at <= ${now}
        ORDER BY next_run_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const picked = rows[0];
      if (!picked) return null;
      const row = await tx.provisioningJob.update({
        where: { id: picked.id },
        data: {
          status: 'running',
          attempts: { increment: 1 },
          lockedAt: now,
          updatedAt: now,
        },
      });
      return toJob(row);
    });
  }

  async recoverStaleJobs(now: Date, lockTimeoutMs: number): Promise<number> {
    const cutoff = new Date(now.getTime() - lockTimeoutMs);
    const stale = await this.prisma.provisioningJob.findMany({
      where: { status: 'running', lockedAt: { lt: cutoff } },
    });
    let recovered = 0;
    for (const job of stale) {
      const exhausted = job.attempts >= job.maxAttempts;
      await this.prisma.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'failed' : 'queued',
          lockedAt: null,
          nextRunAt: exhausted ? job.nextRunAt : now,
          lastError: exhausted
            ? 'Provisioning timed out and exceeded the retry limit'
            : 'Provisioning timed out; retrying',
        },
      });
      recovered += 1;
    }
    return recovered;
  }

  async completeJob(id: string): Promise<ProvisioningJob> {
    const row = await this.prisma.provisioningJob.update({
      where: { id },
      data: { status: 'succeeded', lockedAt: null, lastError: null },
    });
    return toJob(row);
  }

  async rescheduleJob(id: string, nextRunAt: Date, error: string | null): Promise<ProvisioningJob> {
    const row = await this.prisma.provisioningJob.update({
      where: { id },
      data: { status: 'queued', lockedAt: null, nextRunAt, lastError: error },
    });
    return toJob(row);
  }

  async failJob(id: string, error: string): Promise<ProvisioningJob> {
    const row = await this.prisma.provisioningJob.update({
      where: { id },
      data: { status: 'failed', lockedAt: null, lastError: error },
    });
    return toJob(row);
  }

  async findJobById(id: string): Promise<ProvisioningJob | null> {
    const row = await this.prisma.provisioningJob.findUnique({ where: { id } });
    return row ? toJob(row) : null;
  }

  async findLatestJobForInstance(instanceId: string): Promise<ProvisioningJob | null> {
    const row = await this.prisma.provisioningJob.findFirst({
      where: { instanceId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toJob(row) : null;
  }

  async listAllJobs(): Promise<ProvisioningJob[]> {
    const rows = await this.prisma.provisioningJob.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toJob);
  }

  async resetJobForRetry(instanceId: string, maxAttempts: number): Promise<ProvisioningJob> {
    const latest = await this.findLatestJobForInstance(instanceId);
    const now = new Date();
    if (!latest) return this.createJob({ instanceId, maxAttempts });
    const row = await this.prisma.provisioningJob.update({
      where: { id: latest.id },
      data: {
        status: 'queued',
        attempts: 0,
        maxAttempts,
        nextRunAt: now,
        lockedAt: null,
        lastError: null,
      },
    });
    return toJob(row);
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date;
  }): Promise<Session> {
    const row = await this.prisma.session.create({ data: input });
    return toSession(row);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = await this.prisma.session.findUnique({ where: { tokenHash } });
    return row ? toSession(row) : null;
  }

  async updateSessionTokens(
    id: string,
    tokens: { accessToken: string | null; refreshToken: string | null; expiresAt: Date },
  ): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: tokens });
  }

  async deleteSession(id: string): Promise<void> {
    await this.prisma.session.delete({ where: { id } }).catch(() => undefined);
  }

  async deleteSessionsByUser(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }

  async deleteExpiredSessions(now: Date): Promise<number> {
    const res = await this.prisma.session.deleteMany({ where: { expiresAt: { lte: now } } });
    return res.count;
  }

  async createOAuthTransaction(tx: OAuthTransaction): Promise<void> {
    await this.prisma.oAuthTransaction.create({ data: tx });
  }

  async consumeOAuthTransaction(state: string, now: Date): Promise<OAuthTransaction | null> {
    const row = await this.prisma.oAuthTransaction.findUnique({ where: { state } });
    if (!row) return null;
    await this.prisma.oAuthTransaction.delete({ where: { state } }).catch(() => undefined);
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return row;
  }

  async deleteExpiredOAuthTransactions(now: Date): Promise<number> {
    const res = await this.prisma.oAuthTransaction.deleteMany({ where: { expiresAt: { lte: now } } });
    return res.count;
  }

  async recordAudit(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async listAudit(limit: number): Promise<AuditLogEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt,
    }));
  }

  async createBackup(input: {
    label: string | null;
    createdByUserId: string | null;
    schemaVersion: number;
    counts: Record<string, number>;
    payload: PlatformSnapshot;
  }): Promise<BackupSnapshotMeta> {
    const row = await this.prisma.backupSnapshot.create({
      data: {
        label: input.label,
        createdByUserId: input.createdByUserId,
        schemaVersion: input.schemaVersion,
        counts: input.counts as Prisma.InputJsonValue,
        payload: input.payload as unknown as Prisma.InputJsonValue,
      },
    });
    return toBackupMeta(row);
  }

  async listBackups(): Promise<BackupSnapshotMeta[]> {
    const rows = await this.prisma.backupSnapshot.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        schemaVersion: true,
        createdByUserId: true,
        counts: true,
        createdAt: true,
      },
    });
    return rows.map(toBackupMeta);
  }

  async findBackupById(id: string): Promise<BackupSnapshot | null> {
    const row = await this.prisma.backupSnapshot.findUnique({ where: { id } });
    if (!row) return null;
    return {
      ...toBackupMeta(row),
      payload: row.payload as unknown as PlatformSnapshot,
    };
  }

  async deleteBackup(id: string): Promise<void> {
    await this.prisma.backupSnapshot.delete({ where: { id } }).catch(() => undefined);
  }
}
