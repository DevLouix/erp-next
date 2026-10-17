import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/domain/memoryStore.js';
import { InstanceService } from '../src/instances/instanceService.js';
import { ProvisioningWorker, computeBackoffMs } from '../src/provisioning/worker.js';
import { silentLogger } from '../src/lib/logger.js';
import { testConfig } from '../src/config.js';
import type { Instance, User } from '../src/domain/types.js';
import { FakeBench, FakeHealth } from './helpers/fakes.js';
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
  return service.create(owner, { companyName: name, idempotencyKey: null });
}

function makeWorker(
  bench: FakeBench,
  health = new FakeHealth(),
  configOverride?: Partial<typeof config>,
) {
  return new ProvisioningWorker({
    store,
    config: configOverride ? { ...config, ...configOverride } : config,
    bench,
    health,
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
  });

  it('computes exponential backoff with a ceiling', () => {
    expect(computeBackoffMs(1)).toBe(30_000);
    expect(computeBackoffMs(2)).toBe(60_000);
    expect(computeBackoffMs(10)).toBe(15 * 60_000);
  });
});
