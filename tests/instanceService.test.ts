import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/domain/memoryStore.js';
import { InstanceService } from '../src/instances/instanceService.js';
import { testConfig } from '../src/config.js';
import { NotFoundError, ValidationError } from '../src/domain/errors.js';
import type { User } from '../src/domain/types.js';

const config = testConfig();

let store: MemoryStore;
let service: InstanceService;
let owner: User;
let other: User;
let admin: User;

beforeEach(async () => {
  store = new MemoryStore();
  service = new InstanceService(store, config);
  owner = await store.createUser({ oauthSubject: 'owner', email: 'owner@test', name: 'Owner', role: 'user' });
  other = await store.createUser({ oauthSubject: 'other', email: 'other@test', name: 'Other', role: 'user' });
  admin = await store.createUser({ oauthSubject: 'admin', email: 'admin@test', name: 'Admin', role: 'admin' });
});

describe('InstanceService.create', () => {
  it('creates a queued instance and enqueues a job', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    expect(instance.status).toBe('queued');
    expect(instance.hostname).toBe('acme-corp.apps.example.test');

    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(0);
  });

  it('is idempotent for a repeated Idempotency-Key', async () => {
    const first = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: 'key-1' });
    const second = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: 'key-1' });
    expect(second.id).toBe(first.id);
    expect(await store.listInstancesByOwner(owner.id)).toHaveLength(1);
  });

  it('gives a different owner a unique hostname instead of failing', async () => {
    const first = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    const second = await service.create(other, { companyName: 'Acme Corp', idempotencyKey: null });
    expect(second.hostname).not.toBe(first.hostname);
    expect(second.hostname.startsWith('acme-corp-')).toBe(true);
  });

  it('rejects reserved names', async () => {
    await expect(service.create(owner, { companyName: 'www', idempotencyKey: null })).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('InstanceService ownership', () => {
  it('hides other users instances', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    await expect(service.getFor(other, instance.id)).rejects.toThrow(NotFoundError);
    await expect(service.getFor(owner, instance.id)).resolves.toMatchObject({ id: instance.id });
  });

  it('lets admins read any instance', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    await expect(service.getFor(admin, instance.id)).resolves.toMatchObject({ id: instance.id });
  });

  it('limits listFor to owned instances', async () => {
    await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    await service.create(other, { companyName: 'Globex', idempotencyKey: null });
    expect(await service.listFor(owner)).toHaveLength(1);
    expect(await service.listFor(admin)).toHaveLength(2);
  });
});

describe('InstanceService.retry', () => {
  it('allows an owner to retry their failed provisioning job', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    const job = await store.findLatestJobForInstance(instance.id);
    await store.failJob(job!.id, 'bench failed');
    await store.updateInstance(instance.id, { status: 'failed' });
    const retried = await service.retry(owner, instance.id);
    expect(retried.status).toBe('queued');
  });

  it('does not allow another owner to retry the instance', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    const job = await store.findLatestJobForInstance(instance.id);
    await store.failJob(job!.id, 'bench failed');
    await store.updateInstance(instance.id, { status: 'failed' });
    await expect(service.retry(other, instance.id)).rejects.toThrow(NotFoundError);
  });

  it('re-queues a failed instance', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    const initialJob = await store.findLatestJobForInstance(instance.id);
    await store.failJob(initialJob!.id, 'bench failed');
    await store.updateInstance(instance.id, { status: 'failed', errorMessage: 'boom' });
    const retried = await service.retry(admin, instance.id);
    expect(retried.status).toBe('queued');
    expect(retried.errorMessage).toBeNull();
    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(0);
  });

  it('refuses to retry an in-flight instance', async () => {
    const instance = await service.create(owner, { companyName: 'Acme Corp', idempotencyKey: null });
    await store.updateInstance(instance.id, { status: 'provisioning' });
    await expect(service.retry(admin, instance.id)).rejects.toThrow(ValidationError);
  });
});
