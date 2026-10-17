import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
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
  JobType,
  OAuthTransaction,
  PlatformSnapshot,
  ProvisioningJob,
  Session,
  SiteBackup,
  SiteBackupPart,
  SiteBackupSettings,
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
  companyName: string;
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
  type: string;
  siteBackupId: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ProvisioningJob {
  return {
    ...row,
    type: row.type as JobType,
    status: row.status as ProvisioningJob['status'],
  };
}

const siteBackupPartSchema = z.object({
  kind: z.enum(['database', 'public-files', 'private-files', 'site-config']),
  relativePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  s3ObjectKey: z.string().optional(),
});

function toSiteBackup(row: {
  id: string;
  siteName: string;
  hostname: string;
  status: string;
  parts: unknown;
  createdByUserId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): SiteBackup {
  return {
    ...row,
    status: row.status as SiteBackup['status'],
    parts: z.array(siteBackupPartSchema).parse(row.parts),
  };
}

function toSiteBackupSettings(row: {
  automaticEnabled: boolean;
  intervalHours: number;
  nextRunAt: Date | null;
  s3Endpoint: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  updatedAt: Date;
}): SiteBackupSettings {
  return row;
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
          companyName: input.companyName,
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
    patch: Partial<{ companyName: string; status: InstanceStatus; errorMessage: string | null }>,
  ): Promise<Instance> {
    const row = await this.prisma.instance.update({ where: { id }, data: patch });
    return toInstance(row);
  }

  async queueInstanceDeletion(instanceId: string, maxAttempts: number): Promise<ProvisioningJob> {
    return this.prisma.$transaction(async (tx) => {
      const instance = await tx.instance.findUnique({ where: { id: instanceId } });
      if (!instance) throw new Error(`Instance not found: ${instanceId}`);
      const active = await tx.provisioningJob.findFirst({
        where: {
          instanceId,
          status: { in: ['queued', 'running'] },
        },
      });
      if (active) throw new DuplicateError('active_job_for_instance', instanceId);
      const latest = await tx.provisioningJob.findFirst({
        where: { instanceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const now = new Date();
      const job = latest
        ? await tx.provisioningJob.update({
            where: { id: latest.id },
            data: {
              type: 'delete',
              status: 'queued',
              attempts: 0,
              maxAttempts,
              nextRunAt: now,
              lockedAt: null,
              lastError: null,
              siteBackupId: null,
            },
          })
        : await tx.provisioningJob.create({
            data: { instanceId, type: 'delete', maxAttempts },
          });
      await tx.instance.update({
        where: { id: instanceId },
        data: { status: 'deleting', errorMessage: null },
      });
      return toJob(job);
    });
  }

  async deleteInstance(id: string): Promise<void> {
    await this.prisma.instance.delete({ where: { id } });
  }

  async queueSiteBackup(
    instance: Instance,
    actorUserId: string,
    maxAttempts: number,
  ): Promise<SiteBackup> {
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.provisioningJob.findFirst({
        where: {
          instanceId: instance.id,
          status: { in: ['queued', 'running'] },
        },
      });
      if (active) throw new DuplicateError('active_job_for_instance', instance.id);
      const backup = await tx.siteBackup.create({
        data: {
          siteName: instance.siteName,
          hostname: instance.hostname,
          createdByUserId: actorUserId,
        },
      });
      await tx.provisioningJob.create({
        data: {
          instanceId: instance.id,
          type: 'backup',
          siteBackupId: backup.id,
          maxAttempts,
        },
      });
      return toSiteBackup(backup);
    });
  }

  async createSiteBackupRecord(
    siteName: string,
    hostname: string,
    actorUserId: string | null,
  ): Promise<SiteBackup> {
    const backup = await this.prisma.siteBackup.create({
      data: { siteName, hostname, createdByUserId: actorUserId },
    });
    return toSiteBackup(backup);
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
    const { parts, ...fields } = patch;
    const jsonParts: Prisma.InputJsonValue[] | undefined = parts?.map((part) => ({
      kind: part.kind,
      relativePath: part.relativePath,
      sizeBytes: part.sizeBytes,
    }));
    const backup = await this.prisma.siteBackup.update({
      where: { id },
      data: { ...fields, ...(jsonParts ? { parts: jsonParts } : {}) },
    });
    return toSiteBackup(backup);
  }

  async findSiteBackup(id: string): Promise<SiteBackup | null> {
    const backup = await this.prisma.siteBackup.findUnique({ where: { id } });
    return backup ? toSiteBackup(backup) : null;
  }

  async listSiteBackups(siteName: string): Promise<SiteBackup[]> {
    const backups = await this.prisma.siteBackup.findMany({
      where: { siteName },
      orderBy: { createdAt: 'desc' },
    });
    return backups.map(toSiteBackup);
  }

  async listAllSiteBackups(): Promise<SiteBackup[]> {
    const backups = await this.prisma.siteBackup.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return backups.map(toSiteBackup);
  }

  async listSiteBackupsByOwner(ownerUserId: string): Promise<SiteBackup[]> {
    const backups = await this.prisma.siteBackup.findMany({
      where: { createdByUserId: ownerUserId },
      orderBy: { createdAt: 'desc' },
    });
    return backups.map(toSiteBackup);
  }

  async getSiteBackupSettings(): Promise<SiteBackupSettings> {
    const settings = await this.prisma.siteBackupSettings.findUnique({ where: { id: 1 } });
    return settings ?? {
      automaticEnabled: false,
      intervalHours: 24,
      nextRunAt: null,
      s3Endpoint: null,
      s3Bucket: null,
      s3Region: null,
      updatedAt: new Date(0),
    };
  }

  async updateSiteBackupSettings(
    settings: Pick<
      SiteBackupSettings,
      'automaticEnabled' | 'intervalHours' | 's3Endpoint' | 's3Bucket' | 's3Region'
    >,
    now: Date,
  ): Promise<SiteBackupSettings> {
    const nextRunAt = settings.automaticEnabled
      ? new Date(now.getTime() + settings.intervalHours * 60 * 60 * 1000)
      : null;
    const result = await this.prisma.siteBackupSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...settings, nextRunAt },
      update: { ...settings, nextRunAt },
    });
    return toSiteBackupSettings(result);
  }

  async queueScheduledSiteBackups(now: Date, maxAttempts: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const settings = await tx.siteBackupSettings.findUnique({ where: { id: 1 } });
      if (!settings?.automaticEnabled || !settings.nextRunAt || settings.nextRunAt > now) {
        return 0;
      }
      const claimed = await tx.siteBackupSettings.updateMany({
        where: {
          id: 1,
          automaticEnabled: true,
          nextRunAt: { lte: now },
        },
        data: {
          nextRunAt: new Date(now.getTime() + settings.intervalHours * 60 * 60 * 1000),
        },
      });
      if (claimed.count === 0) return 0;

      const instances = await tx.instance.findMany({ where: { status: 'ready' } });
      let queued = 0;
      for (const instance of instances) {
        const active = await tx.provisioningJob.findFirst({
          where: {
            instanceId: instance.id,
            status: { in: ['queued', 'running'] },
          },
        });
        if (active) continue;
        const backup = await tx.siteBackup.create({
          data: {
            siteName: instance.siteName,
            hostname: instance.hostname,
            createdByUserId: instance.ownerUserId,
          },
        });
        await tx.provisioningJob.create({
          data: {
            instanceId: instance.id,
            type: 'backup',
            siteBackupId: backup.id,
            maxAttempts,
          },
        });
        queued += 1;
      }
      return queued;
    });
  }

  async importInstance(input: ImportInstanceInput): Promise<Instance> {
    const row = await this.prisma.instance.upsert({
      where: { siteName: input.siteName },
      create: {
        ownerUserId: input.ownerUserId,
        companyName: input.companyName,
        siteName: input.siteName,
        hostname: input.hostname,
        status: input.status,
        errorMessage: input.errorMessage,
      },
      update: {
        ownerUserId: input.ownerUserId,
        companyName: input.companyName,
        hostname: input.hostname,
        status: input.status,
        errorMessage: input.errorMessage,
      },
    });
    return toInstance(row);
  }

  async createJob(input: CreateJobInput): Promise<ProvisioningJob> {
    const row = await this.prisma.provisioningJob.create({
      data: {
        instanceId: input.instanceId,
        maxAttempts: input.maxAttempts,
        type: input.type ?? 'provision',
        siteBackupId: input.siteBackupId ?? null,
      },
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
        type: 'provision',
        attempts: 0,
        maxAttempts,
        nextRunAt: now,
        lockedAt: null,
        lastError: null,
        siteBackupId: null,
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
