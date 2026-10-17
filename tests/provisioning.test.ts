import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/domain/memoryStore.js';
import { InstanceService } from '../src/instances/instanceService.js';
import { ProvisioningWorker, computeBackoffMs } from '../src/provisioning/worker.js';
import { silentLogger } from '../src/lib/logger.js';
import { testConfig } from '../src/config.js';
import type { Instance, User } from '../src/domain/types.js';
import { FakeBench, FakeHealth } from './helpers/fakes.js';

const config = testConfig();

let store: MemoryStore;
let service: InstanceService;
let owner: User;

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
