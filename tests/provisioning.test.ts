import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/domain/memoryStore.js';
import { InstanceService } from '../src/instances/instanceService.js';
import { ProvisioningWorker, computeBackoffMs } from '../src/provisioning/worker.js';
import { silentLogger } from '../src/lib/logger.js';
import { testConfig } from '../src/config.js';
import type { Instance, User } from '../src/domain/types.js';
import { FakeBench, FakeDomainIngress, FakeHealth } from './helpers/fakes.js';
import { encryptCredential } from '../src/admin/credentialEncryption.js';

const config = testConfig();

let store: MemoryStore;
let service: InstanceService;
let owner: User;

const encryptedS3Credentials = {
  accessKeyCiphertext: encryptCredential('test-access-key', config.BACKUP_CREDENTIALS_ENCRYPTION_KEY),
  secretKeyCiphertext: encryptCredential('test-secret-key', config.BACKUP_CREDENTIALS_ENCRYPTION_KEY),
};

beforeEach(async () => {
  store = new MemoryStore();
  service = new InstanceService(store, config);
  owner = await store.createUser({ oauthSubject: 'owner', email: 'owner@test', name: 'Owner', role: 'user' });
});

async function seed(name = 'Acme Corp'): Promise<Instance> {
  return service.create(owner, {
    companyName: name,
    adminPassword: 'secure-test-password',
    idempotencyKey: null,
  });
}

function makeWorker(
  bench: FakeBench,
  health = new FakeHealth(),
  configOverride?: Partial<typeof config>,
  domainIngress = new FakeDomainIngress(),
) {
  return new ProvisioningWorker({
    store,
    config: configOverride ? { ...config, ...configOverride } : config,
    bench,
    health,
    domainIngress,
    logger: silentLogger,
  });
}

describe('ProvisioningWorker happy path', () => {
  it('runs the documented bench steps and marks the instance ready', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    const worker = makeWorker(bench);

    const claimed = await store.claimNextJob(new Date());
    expect(claimed).not.toBeNull();
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('ready');

    const updated = await store.findInstanceById(instance.id);
    expect(updated?.status).toBe('ready');
    expect(updated?.errorMessage).toBeNull();

    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('succeeded');

    expect(bench.calls.map((c) => c.op)).toEqual([
      'new-site',
      'ensure-app',
      'set-hostname',
      'configure-routing',
    ]);
    expect(bench.installedApps.has('erpnext')).toBe(true);
  });

  it('treats a routing failure as non-fatal by default and still succeeds', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    bench.failOn.add('configureRouting');
    const worker = makeWorker(bench);

    const claimed = await store.claimNextJob(new Date());
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('ready');
    expect((await store.findInstanceById(instance.id))?.status).toBe('ready');
  });

  it('fails the attempt on a routing error in strict mode', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    bench.failOn.add('configureRouting');
    const worker = makeWorker(bench, new FakeHealth(), { PROVISION_ROUTING_MODE: 'strict' });

    const claimed = await store.claimNextJob(new Date());
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('retry');
    expect((await store.findInstanceById(instance.id))?.status).toBe('queued');
  });

  it('does no work for an instance that is already ready', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    const bench = new FakeBench();
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('ready');
    expect(bench.calls).toHaveLength(0);
  });
});

describe('ProvisioningWorker login credential changes', () => {
  it('applies and promotes a queued Administrator password update', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    const initialJob = await store.findLatestJobForInstance(instance.id);
    await store.completeJob(initialJob!.id);

    await service.changeLoginPassword(owner, instance.id, 'new-secure-password');
    const job = await store.claimNextJob(new Date());
    expect(job?.type).toBe('credentials');
    const bench = new FakeBench();
    const result = await makeWorker(bench).processJob(job!);

    expect(result).toBe('ready');
    expect(bench.calls).toContainEqual({
      op: 'set-admin-password',
      args: [instance.siteName, 'new-secure-password'],
    });
    await expect(service.loginCredentialsFor(owner, instance.id)).resolves.toEqual({
      username: 'Administrator',
      password: 'new-secure-password',
    });
    expect((await store.findLatestJobForInstance(instance.id))?.status).toBe('succeeded');
  });

  it('provisions the site using the owner-supplied password', async () => {
    const instance = await seed();
    const job = await store.claimNextJob(new Date());
    const bench = new FakeBench();
    await makeWorker(bench).processJob(job!);
    expect(bench.calls[0]?.args).toEqual([instance.siteName, 'secure-test-password']);
  });

  it('clears the pending password when a stale credential-change job exhausts retries', async () => {
    const limitedService = new InstanceService(store, {
      ...config,
      PROVISION_MAX_ATTEMPTS: 1,
    });
    const instance = await limitedService.create(owner, {
      companyName: 'Acme Corp',
      adminPassword: 'secure-test-password',
      idempotencyKey: null,
    });
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await limitedService.changeLoginPassword(owner, instance.id, 'new-secure-password');
    await store.claimNextJob(new Date());

    expect(await store.recoverStaleJobs(new Date(Date.now() + 10_000), 1_000)).toBe(1);

    const credentials = await store.findInstanceCredentials(instance.id);
    expect(credentials?.pendingAdminPasswordCiphertext).toBeNull();
    await expect(limitedService.loginCredentialsFor(owner, instance.id)).resolves.toEqual({
      username: 'Administrator',
      password: 'secure-test-password',
    });
  });
});

describe('custom domain lifecycle', () => {
  it('verifies DNS ownership, configures Frappe routing, and removes the alias', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    const dns = {
      resolveTxt: async () => {
        const saved = await store.findInstanceById(instance.id);
        return [[`erpnext-domain-verification=${saved?.customDomainVerificationToken}`]];
      },
      resolve4: async () => ['203.0.113.25'],
      resolve6: async () => [],
    };
    service = new InstanceService(store, config, dns);
    await service.addCustomDomain(owner, instance.id, ' ERP.Acme.com. ');
    await service.verifyCustomDomain(owner, instance.id);

    const pending = await store.findInstanceById(instance.id);
    expect(pending?.customDomain).toBe('erp.acme.com');
    expect(pending?.customDomainStatus).toBe('configuring');
    const bench = new FakeBench();
    const health = new FakeHealth();
    const ingress = new FakeDomainIngress();
    const worker = makeWorker(bench, health, undefined, ingress);
    await worker.processJob((await store.claimNextJob(new Date()))!);

    expect(bench.calls).toContainEqual({
      op: 'add-domain',
      args: [instance.siteName, 'erp.acme.com'],
    });
    expect(health.hosts).toContain('erp.acme.com');
    expect(ingress.calls).toContainEqual({ op: 'configure', domain: 'erp.acme.com' });
    expect((await store.findInstanceById(instance.id))?.customDomainStatus).toBe('active');

    await service.removeCustomDomain(owner, instance.id);
    await worker.processJob((await store.claimNextJob(new Date()))!);
    expect(ingress.calls).toContainEqual({ op: 'remove', domain: 'erp.acme.com' });
    expect(bench.calls).toContainEqual({
      op: 'remove-domain',
      args: [instance.siteName, 'erp.acme.com'],
    });
    expect((await store.findInstanceById(instance.id))?.customDomain).toBeNull();
    expect((await store.findLatestJobForInstance(instance.id))?.status).toBe('succeeded');
  });

  it('does not bind a domain unless the ownership TXT proof matches', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    service = new InstanceService(store, config, {
      resolveTxt: async () => [['wrong-token']],
      resolve4: async () => ['203.0.113.25'],
      resolve6: async () => [],
    });
    await service.addCustomDomain(owner, instance.id, 'erp.acme.com');
    await expect(service.verifyCustomDomain(owner, instance.id)).rejects.toThrow('TXT record');
    expect((await store.findLatestJobForInstance(instance.id))?.type).toBe('provision');
    expect((await store.findInstanceById(instance.id))?.customDomainStatus).toBe('pending');
  });

  it('does not create Frappe jobs until the custom hostname points to this ingress', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    service = new InstanceService(store, config, {
      resolveTxt: async () => {
        const saved = await store.findInstanceById(instance.id);
        return [[`erpnext-domain-verification=${saved?.customDomainVerificationToken}`]];
      },
      resolve4: async (hostname) => hostname === 'erp.acme.com'
        ? ['198.51.100.20']
        : ['203.0.113.25'],
      resolve6: async () => [],
    });
    await service.addCustomDomain(owner, instance.id, 'erp.acme.com');
    await expect(service.verifyCustomDomain(owner, instance.id)).rejects.toThrow('same ingress');
    expect((await store.findLatestJobForInstance(instance.id))?.type).toBe('provision');
    expect((await store.findInstanceById(instance.id))?.customDomainStatus).toBe('pending');
  });

  it('records terminal Frappe alias failures without marking the instance failed', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    service = new InstanceService(store, {
      ...config,
      PROVISION_MAX_ATTEMPTS: 1,
    }, {
      resolveTxt: async () => {
        const saved = await store.findInstanceById(instance.id);
        return [[`erpnext-domain-verification=${saved?.customDomainVerificationToken}`]];
      },
      resolve4: async () => ['203.0.113.25'],
      resolve6: async () => [],
    });
    await service.addCustomDomain(owner, instance.id, 'erp.acme.com');
    await service.verifyCustomDomain(owner, instance.id);
    const bench = new FakeBench();
    bench.failOn.add('addDomain');
    const worker = makeWorker(bench, new FakeHealth(), { PROVISION_MAX_ATTEMPTS: 1 });
    expect(await worker.processJob((await store.claimNextJob(new Date()))!)).toBe('failed');
    const updated = await store.findInstanceById(instance.id);
    expect(updated?.status).toBe('ready');
    expect(updated?.customDomainStatus).toBe('failed');
    expect(updated?.customDomainError).toContain('bench addDomain failed');
  });

  it('requires a custom domain route to be detached before deleting its workspace', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await service.addCustomDomain(owner, instance.id, 'erp.acme.com');
    await expect(service.deleteFor(owner, instance.id, instance.hostname))
      .rejects.toThrow('Detach erp.acme.com here and remove its DNS record');
    expect((await store.findLatestJobForInstance(instance.id))?.type).toBe('provision');
  });
});

describe('ProvisioningWorker failure handling', () => {
  it('retries with a recorded error and cleans up the partial site', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    bench.failOn.add('newSite');
    const worker = makeWorker(bench);

    const claimed = await store.claimNextJob(new Date());
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('retry');

    const updated = await store.findInstanceById(instance.id);
    expect(updated?.status).toBe('queued');
    expect(updated?.errorMessage).toContain('bench newSite failed');

    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(1);
    expect(job!.nextRunAt.getTime()).toBeGreaterThan(Date.now() - 1000);
    // A cleanup was attempted.
    expect(bench.calls.some((c) => c.op === 'drop-site')).toBe(true);
  });

  it('marks the instance failed once attempts are exhausted', async () => {
    const instance = await seed();
    await store.resetJobForRetry(instance.id, 1); // maxAttempts = 1
    const bench = new FakeBench();
    bench.failOn.add('ensureAppInstalled');
    const worker = makeWorker(bench);

    const claimed = await store.claimNextJob(new Date());
    expect(claimed?.attempts).toBe(1);
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('failed');

    const updated = await store.findInstanceById(instance.id);
    expect(updated?.status).toBe('failed');
    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('failed');
  });

  it('never leaks database credentials into the recorded error', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    bench.failOn.add('newSite');
    bench.failMessage = `MariaDB error: access denied for password ${config.MARIADB_ROOT_PASSWORD}`;
    const worker = makeWorker(bench);

    const claimed = await store.claimNextJob(new Date());
    await worker.processJob(claimed!);

    const updated = await store.findInstanceById(instance.id);
    expect(updated?.errorMessage).not.toContain(config.MARIADB_ROOT_PASSWORD);
    expect(updated?.errorMessage).toContain('[REDACTED]');
  });

  it('fails the instance when the health check never passes', async () => {
    const instance = await seed();
    await store.resetJobForRetry(instance.id, 1);
    const bench = new FakeBench();
    const health = new FakeHealth(100); // always fails
    const worker = makeWorker(bench, health);

    const claimed = await store.claimNextJob(new Date());
    const outcome = await worker.processJob(claimed!);
    expect(outcome).toBe('failed');
    expect((await store.findInstanceById(instance.id))?.status).toBe('failed');
  });
});

describe('ProvisioningWorker site deletion', () => {
  it('drops the tenant site and removes its platform record', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await service.deleteFor(owner, instance.id, instance.hostname);
    const bench = new FakeBench();
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());
    expect(claimed?.type).toBe('delete');
    expect(await worker.processJob(claimed!)).toBe('deleted');
    expect(await store.findInstanceById(instance.id)).toBeNull();
    expect(bench.calls.map((call) => call.op)).toContain('drop-site');
    const safetyBackups = await store.listSiteBackups(instance.siteName);
    expect(safetyBackups).toHaveLength(1);
    expect(safetyBackups[0]?.status).toBe('completed');
    expect(safetyBackups[0]?.createdByUserId).toBe(owner.id);
  });

  it('retains the instance and retries if Frappe refuses to drop the site', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await service.deleteFor(owner, instance.id, instance.hostname);
    const bench = new FakeBench();
    bench.failOn.add('dropSite');
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());
    expect(await worker.processJob(claimed!)).toBe('retry');
    expect((await store.findInstanceById(instance.id))?.status).toBe('deleting');
  });

  it('does not delete a tenant if its automatic pre-delete backup fails', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await service.deleteFor(owner, instance.id, instance.hostname);
    const bench = new FakeBench();
    bench.failOn.add('backupSite');
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());
    expect(await worker.processJob(claimed!)).toBe('retry');
    expect(await store.findInstanceById(instance.id)).not.toBeNull();
    expect(bench.calls.map((call) => call.op)).not.toContain('drop-site');
    expect((await store.listSiteBackups(instance.siteName))[0]?.status).toBe('failed');
  });

  it('allows deletion after a verified local pre-delete backup when optional S3 is unavailable', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    await store.updateSiteBackupSettings(
      {
        automaticEnabled: false,
        intervalHours: 24,
        s3Endpoint: 'https://objects.example.test',
        s3Bucket: 'erpnext-backups',
        s3Region: 'us-east-1',
      },
      new Date(),
      encryptedS3Credentials,
    );
    await service.deleteFor(owner, instance.id, instance.hostname);
    const bench = new FakeBench();
    bench.failOn.add('uploadBackup');
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());

    expect(await worker.processJob(claimed!)).toBe('deleted');
    expect(await store.findInstanceById(instance.id)).toBeNull();
    const safetyBackup = (await store.listSiteBackups(instance.siteName))[0];
    expect(safetyBackup?.status).toBe('completed');
    expect(safetyBackup?.parts).toHaveLength(4);
    expect(safetyBackup?.errorMessage).toContain('local backup remains available');
    expect(bench.calls.map((call) => call.op)).toContain('drop-site');
  });
});

describe('ProvisioningWorker site backups', () => {
  it('archives complete tenant backups before reporting success', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    const backup = await store.queueSiteBackup(instance, owner.id, 3);
    const bench = new FakeBench();
    const worker = makeWorker(bench);
    const claimed = await store.claimNextJob(new Date());
    expect(await worker.processJob(claimed!)).toBe('ready');
    expect((await store.findSiteBackup(backup.id))?.status).toBe('completed');
    expect((await store.findSiteBackup(backup.id))?.parts).toHaveLength(4);
  });

  it('uploads configured automatic backups to the selected S3-compatible target', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    const now = new Date();
    await store.updateSiteBackupSettings(
      {
        automaticEnabled: true,
        intervalHours: 24,
        s3Endpoint: 'https://objects.example.test',
        s3Bucket: 'erpnext-backups',
        s3Region: 'us-east-1',
      },
      now,
      encryptedS3Credentials,
    );
    expect(
      await store.queueScheduledSiteBackups(new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1), 3),
    ).toBe(1);
    const bench = new FakeBench();
    const worker = makeWorker(bench);
    const job = await store.claimNextJob(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect(await worker.processJob(job!)).toBe('ready');
    expect(bench.calls.map((call) => call.op)).toContain('upload-backup');
    const saved = (await store.listSiteBackups(instance.siteName))[0];
    expect(saved?.parts.every((part) => Boolean(part.s3ObjectKey))).toBe(true);
  });

  it('keeps verified local archives downloadable when the optional S3 upload fails', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    const now = new Date();
    await store.updateSiteBackupSettings(
      {
        automaticEnabled: false,
        intervalHours: 24,
        s3Endpoint: 'https://objects.example.test',
        s3Bucket: 'erpnext-backups',
        s3Region: 'us-east-1',
      },
      now,
      encryptedS3Credentials,
    );
    const backup = await store.queueSiteBackup(instance, owner.id, 3);
    const bench = new FakeBench();
    bench.failOn.add('uploadBackup');
    const worker = makeWorker(bench);
    const job = await store.claimNextJob(new Date());

    expect(await worker.processJob(job!)).toBe('ready');
    const saved = await store.findSiteBackup(backup.id);
    expect(saved?.status).toBe('completed');
    expect(saved?.parts).toHaveLength(4);
    expect(saved?.parts.every((part) => !part.s3ObjectKey)).toBe(true);
    expect(saved?.errorMessage).toContain('local backup remains available');
  });

  it('claims an automatic schedule only once after its due time', async () => {
    const instance = await seed();
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);
    const now = new Date();
    await store.updateSiteBackupSettings(
      {
        automaticEnabled: true,
        intervalHours: 24,
        s3Endpoint: null,
        s3Bucket: null,
        s3Region: null,
      },
      now,
    );
    const due = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(await store.queueScheduledSiteBackups(due, 3)).toBe(1);
    expect(await store.queueScheduledSiteBackups(due, 3)).toBe(0);
    expect((await store.findLatestJobForInstance(instance.id))?.type).toBe('backup');
  });
});

describe('worker recovery', () => {
  it('re-queues a job whose worker died mid-run', async () => {
    const instance = await seed();
    await store.claimNextJob(new Date()); // sets status running + lockedAt
    const recovered = await store.recoverStaleJobs(new Date(Date.now() + 60_000), 1000);
    expect(recovered).toBe(1);
    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
    expect(job?.cleanupBeforeRun).toBe(true);
    expect((await store.findInstanceById(instance.id))?.status).toBe('queued');
  });

  it('scans and processes queued work immediately when the worker starts', async () => {
    const instance = await seed();
    const bench = new FakeBench();
    let worker: ProvisioningWorker;
    const originalNewSite = bench.newSite.bind(bench);
    bench.newSite = async (siteName) => {
      await originalNewSite(siteName);
      worker.stop();
    };
    worker = makeWorker(bench);

    await worker.start();

    expect((await store.findInstanceById(instance.id))?.status).toBe('ready');
    expect((await store.findLatestJobForInstance(instance.id))?.status).toBe('succeeded');
  });

  it('recovers and processes an interrupted job during worker startup', async () => {
    const instance = await seed();
    await store.claimNextJob(new Date());
    const bench = new FakeBench();
    let worker: ProvisioningWorker;
    const originalNewSite = bench.newSite.bind(bench);
    bench.newSite = async (siteName) => {
      await originalNewSite(siteName);
      worker.stop();
    };
    worker = new ProvisioningWorker({
      store,
      config: { ...config, PROVISION_LOCK_TIMEOUT_MS: 1_000 },
      bench,
      health: new FakeHealth(),
      domainIngress: new FakeDomainIngress(),
      logger: silentLogger,
      now: () => new Date(Date.now() + 10_000),
    });

    await worker.start();

    expect((await store.findInstanceById(instance.id))?.status).toBe('ready');
    expect((await store.findLatestJobForInstance(instance.id))?.attempts).toBe(2);
  });

  it('marks an exhausted stale provisioning instance failed', async () => {
    const instance = await seed();
    await store.resetJobForRetry(instance.id, 1);
    await store.claimNextJob(new Date());

    expect(await store.recoverStaleJobs(new Date(Date.now() + 10_000), 1_000)).toBe(1);
    expect((await store.findLatestJobForInstance(instance.id))?.status).toBe('failed');
    expect((await store.findInstanceById(instance.id))?.status).toBe('failed');
  });

  it('fences an old worker attempt after its stale job has been reclaimed', async () => {
    const instance = await seed();
    const firstClaim = await store.claimNextJob(new Date());
    if (!firstClaim?.lockedAt) throw new Error('Expected first worker claim');
    const recoveredAt = new Date(Date.now() + 10_000);
    expect(await store.recoverStaleJobs(recoveredAt, 1_000)).toBe(1);
    const secondClaim = await store.claimNextJob(recoveredAt);
    if (!secondClaim?.lockedAt) throw new Error('Expected recovered worker claim');

    expect(await store.completeProvisioningJob(firstClaim.id, instance.id, {
      attempts: firstClaim.attempts,
      lockedAt: firstClaim.lockedAt,
    })).toBe(false);
    expect((await store.findInstanceById(instance.id))?.status).toBe('queued');
    expect(await store.completeProvisioningJob(secondClaim.id, instance.id, {
      attempts: secondClaim.attempts,
      lockedAt: secondClaim.lockedAt,
    })).toBe(true);
    expect((await store.findInstanceById(instance.id))?.status).toBe('ready');
  });

  it('does not continue provisioning after the active job is stopped', async () => {
    const instance = await seed();
    const job = await store.claimNextJob(new Date());
    expect(job).not.toBeNull();
    const bench = new FakeBench();
    const originalNewSite = bench.newSite.bind(bench);
    bench.newSite = async (siteName) => {
      await originalNewSite(siteName);
      expect(await store.stopProvisioning(instance.id, 'Provisioning stopped manually')).toBe(true);
    };

    const outcome = await makeWorker(bench).processJob(job!);

    expect(outcome).toBe('skipped');
    expect(bench.calls.map((call) => call.op)).toEqual(['new-site']);
    expect((await store.findInstanceById(instance.id))?.status).toBe('failed');
    expect((await store.findLatestJobForInstance(instance.id))?.status).toBe('failed');
  });

  it('cleans up an interrupted site before an explicit retry', async () => {
    const instance = await seed();
    const firstClaim = await store.claimNextJob(new Date());
    if (!firstClaim) throw new Error('Expected provisioning job claim');
    expect(await store.stopProvisioning(instance.id, 'Provisioning stopped manually')).toBe(true);
    await service.retry(owner, instance.id);

    const retryJob = await store.claimNextJob(new Date());
    if (!retryJob) throw new Error('Expected retried provisioning job claim');
    expect(retryJob.cleanupBeforeRun).toBe(true);
    const bench = new FakeBench();
    const outcome = await makeWorker(bench).processJob(retryJob);

    expect(outcome).toBe('ready');
    expect(bench.calls.map((call) => call.op).slice(0, 2)).toEqual(['drop-site', 'new-site']);
  });

  it('computes exponential backoff with a ceiling', () => {
    expect(computeBackoffMs(1)).toBe(30_000);
    expect(computeBackoffMs(2)).toBe(60_000);
    expect(computeBackoffMs(10)).toBe(15 * 60_000);
  });
});
