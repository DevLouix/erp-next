import { randomBytes } from 'node:crypto';
import { resolve4, resolve6, resolveTxt } from 'node:dns/promises';
import type { AppConfig } from '../config.js';
import type { Store } from '../domain/store.js';
import type { Instance, User } from '../domain/types.js';
import { DuplicateError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { deriveSiteNaming, normalizeCustomDomain, type SiteNaming } from './validation.js';
import { decryptCredential, encryptCredential } from '../admin/credentialEncryption.js';

export interface CustomDomainDns {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const systemDns: CustomDomainDns = { resolveTxt, resolve4, resolve6 };
const CUSTOM_DOMAIN_CLAIM_TTL_MS = 48 * 60 * 60 * 1000;

export interface CreateInstanceRequest {
  companyName: string;
  adminPassword: string;
  idempotencyKey: string | null;
}

export class InstanceService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly dns: CustomDomainDns = systemDns,
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

    this.validateAdminPassword(request.adminPassword);
    const naming = await this.chooseNaming(request.companyName);

    try {
      const instance = await this.store.createInstance({
        ownerUserId: owner.id,
        companyName: request.companyName.trim(),
        siteName: naming.siteName,
        hostname: naming.hostname,
        adminPasswordCiphertext: encryptCredential(
          request.adminPassword,
          this.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
        ),
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

  async loginCredentialsFor(
    user: User,
    instanceId: string,
  ): Promise<{ username: 'Administrator'; password: string }> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status !== 'ready') {
      throw new ValidationError('Login credentials are available once the instance is ready');
    }
    const credentials = await this.store.findInstanceCredentials(instanceId);
    if (!credentials?.adminPasswordCiphertext) {
      throw new ValidationError('Set a new Administrator password to recover access to this instance');
    }
    const password = decryptCredential(
      credentials.adminPasswordCiphertext,
      this.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
    );
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.credentials_revealed',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { hostname: instance.hostname },
    });
    return { username: 'Administrator', password };
  }

  async changeLoginPassword(
    user: User,
    instanceId: string,
    password: string,
  ): Promise<void> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status !== 'ready') {
      throw new ValidationError('Login credentials can only be changed on a ready instance');
    }
    this.validateAdminPassword(password);
    try {
      await this.store.queueInstanceCredentialChange(
        instanceId,
        encryptCredential(password, this.config.BACKUP_CREDENTIALS_ENCRYPTION_KEY),
        this.config.PROVISION_MAX_ATTEMPTS,
      );
    } catch (err) {
      if (err instanceof DuplicateError) {
        throw new ValidationError('Another instance operation is already in progress');
      }
      throw err;
    }
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.credentials_change_requested',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { hostname: instance.hostname },
    });
  }

  async hasLoginCredentials(instanceId: string): Promise<boolean> {
    const credentials = await this.store.findInstanceCredentials(instanceId);
    return Boolean(credentials?.adminPasswordCiphertext);
  }

  async addCustomDomain(user: User, instanceId: string, input: string): Promise<Instance> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status !== 'ready') {
      throw new ValidationError('Custom domains can only be added to a ready instance');
    }
    const now = new Date();
    if (instance.customDomain) {
      if (
        instance.customDomainStatus === 'pending' &&
        instance.customDomainCreatedAt &&
        now.getTime() - instance.customDomainCreatedAt.getTime() >= CUSTOM_DOMAIN_CLAIM_TTL_MS
      ) {
        await this.clearCustomDomain(instanceId);
      } else {
        throw new ValidationError('Remove the current custom domain before adding another');
      }
    }
    const domain = normalizeCustomDomain(input);
    const platformDomain = this.config.PROVISIONING_BASE_DOMAIN.toLowerCase();
    if (domain === instance.hostname || domain.endsWith(`.${platformDomain}`)) {
      throw new ValidationError('Use a domain outside the platform-managed domain');
    }
    const hostnameOwner = await this.store.findInstanceByHostname(domain);
    if (hostnameOwner) throw new ValidationError('This domain is already assigned to a workspace');
    const domainOwner = await this.store.findInstanceByCustomDomain(domain);
    if (domainOwner) {
      const expiredClaim =
        domainOwner.customDomainStatus === 'pending' &&
        domainOwner.customDomainCreatedAt &&
        now.getTime() - domainOwner.customDomainCreatedAt.getTime() >= CUSTOM_DOMAIN_CLAIM_TTL_MS;
      if (!expiredClaim) throw new ValidationError('This domain is already assigned to a workspace');
      await this.clearCustomDomain(domainOwner.id);
    }

    const token = randomBytes(24).toString('hex');
    let updated: Instance;
    try {
      updated = await this.store.updateInstance(instanceId, {
        customDomain: domain,
        customDomainVerificationToken: token,
        customDomainStatus: 'pending',
        customDomainCreatedAt: now,
        customDomainVerifiedAt: null,
        customDomainError: null,
      });
    } catch (err) {
      if (err instanceof DuplicateError) {
        throw new ValidationError('This domain is already assigned to a workspace');
      }
      throw err;
    }
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.custom_domain_added',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { domain },
    });
    return updated;
  }

  async verifyCustomDomain(user: User, instanceId: string): Promise<void> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status !== 'ready' || !instance.customDomain || !instance.customDomainVerificationToken) {
      throw new ValidationError('Add a custom domain to a ready workspace first');
    }
    if (!['pending', 'failed'].includes(instance.customDomainStatus ?? '')) {
      throw new ValidationError('This custom domain cannot be verified in its current state');
    }
    if (
      instance.customDomainStatus === 'pending' &&
      instance.customDomainCreatedAt &&
      Date.now() - instance.customDomainCreatedAt.getTime() >= CUSTOM_DOMAIN_CLAIM_TTL_MS
    ) {
      await this.clearCustomDomain(instanceId);
      throw new ValidationError('The domain verification challenge expired. Add the domain again to get a new TXT value.');
    }
    const txtName = `_erpnext-verification.${instance.customDomain}`;
    let txtRecords: string[][];
    try {
      txtRecords = await this.dns.resolveTxt(txtName);
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
      if (['ENODATA', 'ENOTFOUND', 'ENONAME', 'ESERVFAIL'].includes(code)) {
        throw new ValidationError('The DNS TXT record is not visible yet. Check it and try again after propagation.');
      }
      throw new Error(`DNS verification lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const expectedTxt = `erpnext-domain-verification=${instance.customDomainVerificationToken}`;
    if (!txtRecords.some((record) => record.join('') === expectedTxt)) {
      throw new ValidationError(`The TXT record at ${txtName} does not match the verification value`);
    }
    await this.assertDomainRoutesToWorkspace(instance.customDomain, instance.hostname);
    try {
      await this.store.queueCustomDomainJob(instanceId, {
        customDomainStatus: 'configuring',
        customDomainVerifiedAt: new Date(),
        customDomainError: null,
      }, this.config.PROVISION_MAX_ATTEMPTS);
    } catch (err) {
      if (err instanceof DuplicateError) {
        throw new ValidationError('Another workspace operation is in progress; try again when it finishes');
      }
      throw err;
    }
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.custom_domain_verified',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { domain: instance.customDomain },
    });
  }

  private async assertDomainRoutesToWorkspace(domain: string, hostname: string): Promise<void> {
    const [domainAddresses, hostnameAddresses] = await Promise.all([
      this.resolveAddresses(domain),
      this.resolveAddresses(hostname),
    ]);
    if (domainAddresses.length === 0) {
      throw new ValidationError('The custom hostname does not resolve to an ingress address yet. Add the CNAME/A record and try again after DNS propagation.');
    }
    if (hostnameAddresses.length === 0) {
      throw new Error(`The assigned platform hostname ${hostname} does not resolve to an ingress address`);
    }
    const domainSet = [...new Set(domainAddresses)].sort();
    const hostnameSet = [...new Set(hostnameAddresses)].sort();
    if (domainSet.length !== hostnameSet.length || domainSet.some((address, index) => address !== hostnameSet[index])) {
      throw new ValidationError(`DNS for ${domain} must resolve to the same ingress as ${hostname}. Disable DNS proxying and check its CNAME or A/AAAA target.`);
    }
  }

  private async resolveAddresses(hostname: string): Promise<string[]> {
    const addresses: string[] = [];
    for (const resolve of [this.dns.resolve4, this.dns.resolve6]) {
      try {
        addresses.push(...await resolve(hostname));
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
        if (!['ENODATA', 'ENOTFOUND', 'ENONAME'].includes(code)) {
          throw new Error(`DNS routing lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return addresses;
  }

  async removeCustomDomain(user: User, instanceId: string): Promise<void> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status !== 'ready' || !instance.customDomain) {
      throw new ValidationError('This workspace has no custom domain to remove');
    }
    if (instance.customDomainStatus === 'pending') {
      await this.clearCustomDomain(instanceId);
    } else {
      try {
        await this.store.queueCustomDomainJob(instanceId, {
          customDomainStatus: 'removing',
          customDomainError: null,
        }, this.config.PROVISION_MAX_ATTEMPTS);
      } catch (err) {
        if (err instanceof DuplicateError) {
          throw new ValidationError('Another workspace operation is in progress; try again when it finishes');
        }
        throw err;
      }
    }
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.custom_domain_remove_requested',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { domain: instance.customDomain },
    });
  }

  private validateAdminPassword(password: string): void {
    if (password.length < 12 || password.length > 128) {
      throw new ValidationError('Administrator password must be between 12 and 128 characters');
    }
  }

  private async clearCustomDomain(instanceId: string): Promise<void> {
    await this.store.updateInstance(instanceId, {
      customDomain: null,
      customDomainVerificationToken: null,
      customDomainStatus: null,
      customDomainCreatedAt: null,
      customDomainVerifiedAt: null,
      customDomainError: null,
    });
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

  async updateFor(user: User, instanceId: string, companyName: string): Promise<Instance> {
    const instance = await this.getFor(user, instanceId);
    if (instance.status === 'deleting') {
      throw new ValidationError('This instance is being permanently deleted');
    }
    const name = companyName.trim();
    if (!name || name.length > 100) {
      throw new ValidationError('Company name must be between 1 and 100 characters');
    }
    const updated = await this.store.updateInstance(instanceId, { companyName: name });
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.update',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { companyName: name },
    });
    return updated;
  }

  async deleteFor(user: User, instanceId: string, confirmation: string): Promise<Instance> {
    const instance = await this.getFor(user, instanceId);
    if (instance.customDomain) {
      throw new ValidationError(
        `Detach ${instance.customDomain} here and remove its DNS record before deleting this workspace`,
      );
    }
    if (confirmation !== instance.hostname) {
      throw new ValidationError(`Type ${instance.hostname} exactly to confirm permanent deletion`);
    }
    if (instance.status === 'deleting') return instance;
    if (instance.status !== 'ready' && instance.status !== 'failed') {
      throw new ValidationError('Only ready or failed instances can be permanently deleted');
    }
    await this.store.queueInstanceDeletion(instanceId, this.config.PROVISION_MAX_ATTEMPTS);
    await this.store.recordAudit({
      actorUserId: user.id,
      action: 'instance.delete_requested',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { hostname: instance.hostname, siteName: instance.siteName },
    });
    return (await this.store.findInstanceById(instanceId)) ?? instance;
  }

  /** Re-queue an owner's failed provisioning job, or any failed job for an admin. */
  async retry(actor: User, instanceId: string): Promise<Instance> {
    const instance = await this.getFor(actor, instanceId);
    if (instance.status !== 'failed') {
      throw new ValidationError('Only failed instances can be retried');
    }
    const latestJob = await this.store.findLatestJobForInstance(instanceId);
    if (!latestJob || latestJob.type !== 'provision' || latestJob.status !== 'failed') {
      throw new ValidationError('Only failed provisioning jobs can be retried');
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

  async stopProvisioning(actor: User, instanceId: string): Promise<Instance> {
    const instance = await this.getFor(actor, instanceId);
    const stopped = await this.store.stopProvisioning(
      instanceId,
      'Provisioning stopped manually',
    );
    if (!stopped) {
      throw new ValidationError('This instance has no active provisioning job to stop');
    }
    await this.store.recordAudit({
      actorUserId: actor.id,
      action: 'instance.provisioning_stopped',
      targetType: 'instance',
      targetId: instanceId,
      metadata: { hostname: instance.hostname },
    });
    return (await this.store.findInstanceById(instanceId)) ?? instance;
  }
}
