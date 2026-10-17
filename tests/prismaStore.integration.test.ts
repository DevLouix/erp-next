import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaStore } from '../src/domain/prismaStore.js';

/**
 * Integration test against a real PostgreSQL database.
 *
 * Opt-in: set TEST_DATABASE_URL (e.g. the postgres-test service in
 * docker-compose.yml) and run `pnpm test`. Without it the suite is skipped so
 * the default run needs no database.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PrismaStore (integration)', () => {
  let prisma: PrismaClient;
  let store: PrismaStore;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    store = new PrismaStore(prisma);
    await prisma.auditLog.deleteMany();
    await prisma.provisioningJob.deleteMany();
    await prisma.instance.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('persists users keyed by oauth subject', async () => {
    const created = await store.createUser({
      oauthSubject: 'sub-1',
      email: 'a@example.test',
      name: 'A',
      role: 'user',
    });
    const found = await store.findUserByOauthSubject('sub-1');
    expect(found?.id).toBe(created.id);
  });

  it('claims due jobs atomically without double-processing', async () => {
    const user = await store.createUser({
      oauthSubject: 'sub-2',
      email: 'b@example.test',
      name: null,
      role: 'user',
    });
    const i1 = await store.createInstance({
      ownerUserId: user.id,
      companyName: 'One',
      siteName: 'one.apps.test',
      hostname: 'one.apps.test',
      idempotencyKey: null,
      maxAttempts: 5,
    });
    const i2 = await store.createInstance({
      ownerUserId: user.id,
      companyName: 'Two',
      siteName: 'two.apps.test',
      hostname: 'two.apps.test',
      idempotencyKey: null,
      maxAttempts: 5,
    });
    await store.createJob({ instanceId: i1.id, maxAttempts: 5 });
    await store.createJob({ instanceId: i2.id, maxAttempts: 5 });

    const now = new Date();
    const [a, b] = await Promise.all([store.claimNextJob(now), store.claimNextJob(now)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
    expect(a!.attempts).toBe(1);
    expect(await store.claimNextJob(now)).toBeNull();
  });

  it('recovers a stale running job', async () => {
    const user = await store.findUserByOauthSubject('sub-2');
    const instance = await store.createInstance({
      ownerUserId: user!.id,
      companyName: 'Three',
      siteName: 'three.apps.test',
      hostname: 'three.apps.test',
      idempotencyKey: null,
      maxAttempts: 5,
    });
    await store.createJob({ instanceId: instance.id, maxAttempts: 5 });
    await store.claimNextJob(new Date());

    const recovered = await store.recoverStaleJobs(new Date(Date.now() + 10 * 60_000), 60_000);
    expect(recovered).toBeGreaterThanOrEqual(1);
    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
  });
});
