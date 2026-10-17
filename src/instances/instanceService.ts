import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, User } from '../domain/types.js';
import { DuplicateError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { deriveSiteNaming, type SiteNaming } from './validation.js';

export interface CreateInstanceRequest {
  companyName: string;
  idempotencyKey: string | null;
}

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  /**
   * Create a queued instance and its provisioning job.
   *
   * Idempotent when an `Idempotency-Key` is supplied: a repeat call by the same
   * owner returns the original instance instead of creating another site. The
   * hostname is made unique by appending a short random suffix when the slug is
   * already taken.
   */
  async create(owner: User, request: CreateInstanceRequest): Promise<Instance> {
    if (request.idempotencyKey) {
      const existing = await this.store.findInstanceByOwnerAndIdempotencyKey(
        owner.id,
        request.idempotencyKey,
      );
      if (existing) return existing;
    }

    const naming = await this.chooseNaming(request.companyName);

    try {
      const instance = await this.store.createInstance({
        ownerUserId: owner.id,
        siteName: naming.siteName,
        hostname: naming.hostname,
        idempotencyKey: request.idempotencyKey,
        maxAttempts: this.config.PROVISION_MAX_ATTEMPTS,
      });
      try {
        await this.store.createJob({
          instanceId: instance.id,
          maxAttempts: this.config.PROVISION_MAX_ATTEMPTS,
        });
      } catch (err) {
        await this.store.updateInstance(instance.id, {
          status: 'failed',
          errorMessage: 'Could not enqueue provisioning job',
        });
        throw err;
      }
      await this.store.recordAudit({
        actorUserId: owner.id,
        action: 'instance.create',
        targetType: 'instance',
        targetId: instance.id,
        metadata: { siteName: instance.siteName, hostname: instance.hostname },
      });
      return instance;
    } catch (err) {
      if (err instanceof DuplicateError) {
        if (request.idempotencyKey) {
          const existing = await this.store.findInstanceByOwnerAndIdempotencyKey(
            owner.id,
            request.idempotencyKey,
          );
          if (existing) return existing;
        }
        throw new ValidationError('That site name is already in use', {
          name: 'That site name is already in use, choose another',
        });
      }
      throw err;
    }
  }

  private async chooseNaming(companyName: string): Promise<SiteNaming> {
    const base = deriveSiteNaming(companyName, this.config.PROVISIONING_BASE_DOMAIN);
    let candidate = base;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const hostTaken = await this.store.findInstanceByHostname(candidate.hostname);
      if (!hostTaken) return candidate;
      const suffix = randomBytes(2).toString('hex');
      candidate = deriveSiteNaming(`${base.slug}-${suffix}`, this.config.PROVISIONING_BASE_DOMAIN);
    }
    throw new ValidationError('Could not allocate a unique site name', {
      name: 'Please try a different company name',
    });
  }

  async listFor(user: User): Promise<Instance[]> {
    if (user.role === 'admin') return this.store.listAllInstances();
    return this.store.listInstancesByOwner(user.id);
  }

  /** Ownership-enforced lookup: admins may read any instance, others only theirs. */
  async getFor(user: User, instanceId: string): Promise<Instance> {
    const instance = await this.store.findInstanceById(instanceId);
    if (!instance) throw new NotFoundError('Instance not found');
    if (user.role !== 'admin' && instance.ownerUserId !== user.id) {
      // Do not reveal that the instance exists.
      throw new NotFoundError('Instance not found');
    }
    return instance;
  }

  async getOwnedOrThrow(user: User, instanceId: string): Promise<Instance> {
    return this.getFor(user, instanceId);
  }

  /** Admin-only: re-queue a failed instance's provisioning job. */
  async retry(actor: User, instanceId: string): Promise<Instance> {
    if (actor.role !== 'admin') throw new ForbiddenError('Administrator role required');
    const instance = await this.store.findInstanceById(instanceId);
    if (!instance) throw new NotFoundError('Instance not found');
    const inFlight =
      instance.status === 'queued' ||
      instance.status === 'provisioning' ||
      instance.status === 'installing' ||
      instance.status === 'configuring';
    if (inFlight) {
      throw new ValidationError('Instance is already being provisioned');
    }
    await this.store.resetJobForRetry(instanceId, this.config.PROVISION_MAX_ATTEMPTS);
    const updated = await this.store.updateInstance(instanceId, {
      status: 'queued',
      errorMessage: null,
    });
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'instance.retry',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { hostname: instance.hostname },
    });
    return updated;
  }
}
