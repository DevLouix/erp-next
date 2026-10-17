import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type {
  BackupSnapshot,
  BackupSnapshotMeta,
  ImportOptions,
  PlatformSnapshot,
  SnapshotInstance,
  SnapshotJob,
  SnapshotUser,
  User,
} from '../domain/types.js';
import { BACKUP_SCHEMA_VERSION, INSTANCE_STATUSES, JOB_STATUSES, USER_ROLES } from '../domain/types.js';
import { ForbiddenError, ValidationError } from '../domain/errors.js';

const isoDate = z.string().datetime({ offset: true }).or(z.string().min(1));

const snapshotUserSchema = z.object({
  id: z.string().min(1),
  oauthSubject: z.string().min(1),
  email: z.string().min(1),
  name: z.string().nullable().optional().transform((v) => v ?? null),
  role: z.enum(USER_ROLES),
  disabled: z.boolean(),
  createdAt: isoDate,
});

const snapshotInstanceSchema = z.object({
  id: z.string().min(1),
  ownerUserId: z.string().min(1),
  siteName: z.string().min(1),
  hostname: z.string().min(1),
  status: z.enum(INSTANCE_STATUSES),
  errorMessage: z.string().nullable().optional().transform((v) => v ?? null),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const snapshotJobSchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  nextRunAt: isoDate,
  lastError: z.string().nullable().optional().transform((v) => v ?? null),
});

export const platformSnapshotSchema = z.object({
  app: z.literal('erp-next-platform'),
  schemaVersion: z.number().int().min(1),
  exportedAt: isoDate,
  users: z.array(snapshotUserSchema),
  instances: z.array(snapshotInstanceSchema),
  jobs: z.array(snapshotJobSchema).default([]),
});

export interface ImportSummary {
  dryRun: boolean;
  users: { created: number; updated: number };
  instances: { created: number; updated: number };
  jobsRequeued: number;
  skipped: Array<{ siteName: string; reason: string }>;
}

export class BackupService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  private assertAdmin(actor: User): void {
    if (actor.role !== 'admin') throw new ForbiddenError('Administrator role required');
  }

  /** Build a portable snapshot of current platform state. */
  async exportState(actor: User): Promise<PlatformSnapshot> {
    this.assertAdmin(actor);
    const [users, instances, jobs] = await Promise.all([
      this.store.listUsers(),
      this.store.listAllInstances(),
      this.store.listAllJobs(),
    ]);

    const snapshotUsers: SnapshotUser[] = users.map((u) => ({
      id: u.id,
      oauthSubject: u.oauthSubject,
      email: u.email,
      name: u.name,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt.toISOString(),
    }));
    const snapshotInstances: SnapshotInstance[] = instances.map((i) => ({
      id: i.id,
      ownerUserId: i.ownerUserId,
      siteName: i.siteName,
      hostname: i.hostname,
      status: i.status,
      errorMessage: i.errorMessage,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    }));
    const snapshotJobs: SnapshotJob[] = jobs.map((j) => ({
      id: j.id,
      instanceId: j.instanceId,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      nextRunAt: j.nextRunAt.toISOString(),
      lastError: j.lastError,
    }));

    return {
      app: 'erp-next-platform',
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      users: snapshotUsers,
      instances: snapshotInstances,
      jobs: snapshotJobs,
    };
  }

  /** Persist a snapshot in the platform database for later download/restore. */
  async createBackup(actor: User, label: string | null): Promise<BackupSnapshotMeta> {
    this.assertAdmin(actor);
    const payload = await this.exportState(actor);
    const meta = await this.store.createBackup({
      label: label?.trim() ? label.trim().slice(0, 200) : null,
      createdByUserId: actor.id,
      schemaVersion: payload.schemaVersion,
      counts: {
        users: payload.users.length,
        instances: payload.instances.length,
        jobs: payload.jobs.length,
      },
      payload,
    });
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'backup.create',
      targetType: 'backup',
      targetId: meta.id,
      metadata: { label: meta.label, counts: meta.counts },
    });
    return meta;
  }

  async listBackups(actor: User): Promise<BackupSnapshotMeta[]> {
    this.assertAdmin(actor);
    return this.store.listBackups();
  }

  async getBackup(actor: User, id: string): Promise<BackupSnapshot> {
    this.assertAdmin(actor);
    const backup = await this.store.findBackupById(id);
    if (!backup) throw new ValidationError('Backup not found');
    return backup;
  }

  async deleteBackup(actor: User, id: string): Promise<void> {
    this.assertAdmin(actor);
    await this.store.deleteBackup(id);
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'backup.delete',
      targetType: 'backup',
      targetId: id,
      metadata: null,
    });
  }

  /**
   * Validate and (optionally) apply a snapshot. Merge semantics: users are
   * matched by OAuth subject and instances by site name, so importing the same
   * backup twice is safe. Non-ready instances are always (re-)queued so the
   * target deployment provisions them.
   */
  async importState(
    actor: User,
    rawSnapshot: unknown,
    options: ImportOptions = { dryRun: false },
  ): Promise<ImportSummary> {
    this.assertAdmin(actor);
    const parsed = platformSnapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) {
      throw new ValidationError('Invalid backup file', {
        backup: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const snapshot = parsed.data;
    if (snapshot.schemaVersion > BACKUP_SCHEMA_VERSION) {
      throw new ValidationError(
        `Backup schema version ${snapshot.schemaVersion} is newer than supported (${BACKUP_SCHEMA_VERSION})`,
      );
    }

    const summary: ImportSummary = {
      dryRun: options.dryRun,
      users: { created: 0, updated: 0 },
      instances: { created: 0, updated: 0 },
      jobsRequeued: 0,
      skipped: [],
    };

    const userIdMap = new Map<string, string>();

    for (const snapshotUser of snapshot.users) {
      const existing = await this.store.findUserByOauthSubject(snapshotUser.oauthSubject);
      if (existing) {
        userIdMap.set(snapshotUser.id, existing.id);
        summary.users.updated += 1;
        if (!options.dryRun) {
          await this.store.updateUser(existing.id, {
            email: snapshotUser.email,
            name: snapshotUser.name,
            role: snapshotUser.role,
            disabled: snapshotUser.disabled,
          });
        }
      } else {
        summary.users.created += 1;
        if (!options.dryRun) {
          const created = await this.store.createUser({
            oauthSubject: snapshotUser.oauthSubject,
            email: snapshotUser.email,
            name: snapshotUser.name,
            role: snapshotUser.role,
          });
          userIdMap.set(snapshotUser.id, created.id);
          if (snapshotUser.disabled) await this.store.updateUser(created.id, { disabled: true });
        } else {
          // Placeholder so instance ownership can still be counted.
          userIdMap.set(snapshotUser.id, snapshotUser.id);
        }
      }
    }

    for (const snapshotInstance of snapshot.instances) {
      const ownerUserId = userIdMap.get(snapshotInstance.ownerUserId);
      if (!ownerUserId) {
        summary.skipped.push({
          siteName: snapshotInstance.siteName,
          reason: 'owner not present in backup',
        });
        continue;
      }

      const naming = this.applyDomainOverride(snapshotInstance, options.baseDomainOverride ?? null);
      const existing = await this.store.findInstanceBySiteName(naming.siteName);

      if (existing) {
        summary.instances.updated += 1;
        if (!options.dryRun) {
          await this.store.importInstance({
            ownerUserId,
            siteName: naming.siteName,
            hostname: naming.hostname,
            status: snapshotInstance.status,
            errorMessage: snapshotInstance.errorMessage,
          });
        }
      } else {
        summary.instances.created += 1;
        if (!options.dryRun) {
          await this.store.importInstance({
            ownerUserId,
            siteName: naming.siteName,
            hostname: naming.hostname,
            status: snapshotInstance.status,
            errorMessage: snapshotInstance.errorMessage,
          });
        }
      }

      // Re-provision anything that is not ready on the target deployment.
      if (snapshotInstance.status !== 'ready') {
        summary.jobsRequeued += 1;
        if (!options.dryRun) {
          const imported = await this.store.findInstanceBySiteName(naming.siteName);
          if (imported) {
            await this.store.resetJobForRetry(imported.id, this.config.PROVISION_MAX_ATTEMPTS);
          }
        }
      }
    }

    if (!options.dryRun) {
      await this.store.recordAudit({
        actorUserId: actor.id,
        action: 'backup.import',
        targetType: 'platform',
        targetId: null,
        metadata: {
          usersCreated: summary.users.created,
          usersUpdated: summary.users.updated,
          instancesCreated: summary.instances.created,
          instancesUpdated: summary.instances.updated,
          jobsRequeued: summary.jobsRequeued,
        },
      });
    }

    return summary;
  }

  private applyDomainOverride(
    instance: SnapshotInstance,
    baseDomainOverride: string | null,
  ): { siteName: string; hostname: string } {
    if (!baseDomainOverride) {
      return { siteName: instance.siteName, hostname: instance.hostname };
    }
    const base = baseDomainOverride.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!base) return { siteName: instance.siteName, hostname: instance.hostname };
    const label = instance.hostname.split('.')[0] || instance.siteName.split('.')[0];
    const hostname = `${label}.${base}`;
    return { siteName: hostname, hostname };
  }
}
