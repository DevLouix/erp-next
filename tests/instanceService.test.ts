import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/domain/memoryStore.js';
import { InstanceService } from '../src/instances/instanceService.js';
import { testConfig } from '../src/config.js';
import { NotFoundError, ValidationError } from '../src/domain/errors.js';
import type { User } from '../src/domain/types.js';
import { decryptCredential } from '../src/admin/credentialEncryption.js';

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

const createRequest = (companyName: string, idempotencyKey: string | null = null) => ({
  companyName,
  adminPassword: 'secure-test-password',
  idempotencyKey,
});

describe('InstanceService.create', () => {
  it('creates a queued instance and enqueues a job', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    expect(instance.status).toBe('queued');
    expect(instance.hostname).toBe('acme-corp.apps.example.test');

    const job = await store.findLatestJobForInstance(instance.id);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(0);
    const credentials = await store.findInstanceCredentials(instance.id);
    expect(credentials?.adminPasswordCiphertext).not.toContain('secure-test-password');
    expect(
      decryptCredential(
        credentials!.adminPasswordCiphertext!,
        config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
      ),
    ).toBe('secure-test-password');
  });

  it('is idempotent for a repeated Idempotency-Key', async () => {
    const first = await service.create(owner, createRequest('Acme Corp', 'key-1'));
    const second = await service.create(owner, createRequest('Acme Corp', 'key-1'));
    expect(second.id).toBe(first.id);
    expect(await store.listInstancesByOwner(owner.id)).toHaveLength(1);
  });

  it('gives a different owner a unique hostname instead of failing', async () => {
    const first = await service.create(owner, createRequest('Acme Corp'));
    const second = await service.create(other, createRequest('Acme Corp'));
    expect(second.hostname).not.toBe(first.hostname);
    expect(second.hostname.startsWith('acme-corp-')).toBe(true);
  });

  it('rejects reserved names', async () => {
    await expect(service.create(owner, createRequest('www'))).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('instance login credentials', () => {
  it('reveals the saved Administrator login only after the instance is ready', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    await expect(service.loginCredentialsFor(owner, instance.id)).rejects.toThrow(
      'available once the instance is ready',
    );
    await store.updateInstance(instance.id, { status: 'ready' });
    await expect(service.loginCredentialsFor(owner, instance.id)).resolves.toEqual({
      username: 'Administrator',
      password: 'secure-test-password',
    });
  });

  it('queues a password change without replacing the active recovery password early', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    await store.updateInstance(instance.id, { status: 'ready' });
    await store.completeJob((await store.findLatestJobForInstance(instance.id))!.id);

    await service.changeLoginPassword(owner, instance.id, 'different-test-password');

    const credentials = await store.findInstanceCredentials(instance.id);
    expect(credentials?.adminPasswordCiphertext).not.toContain('secure-test-password');
    expect(credentials?.pendingAdminPasswordCiphertext).not.toContain('different-test-password');
    expect(
      decryptCredential(
        credentials!.adminPasswordCiphertext!,
        config.BACKUP_CREDENTIALS_ENCRYPTION_KEY,
      ),
    ).toBe('secure-test-password');
    expect((await store.findLatestJobForInstance(instance.id))?.type).toBe('credentials');
  });

  it('rejects weak passwords', async () => {
    await expect(
      service.create(owner, {
        companyName: 'Acme Corp',
        adminPassword: 'short',
        idempotencyKey: null,
      }),
    ).rejects.toThrow('between 12 and 128 characters');
  });
});

describe('InstanceService ownership', () => {
  it('hides other users instances', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    await expect(service.getFor(other, instance.id)).rejects.toThrow(NotFoundError);
    await expect(service.getFor(owner, instance.id)).resolves.toMatchObject({ id: instance.id });
  });

  it('lets admins read any instance', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    await expect(service.getFor(admin, instance.id)).resolves.toMatchObject({ id: instance.id });
  });

  it('limits listFor to owned instances', async () => {
    await service.create(owner, createRequest('Acme Corp'));
    await service.create(other, createRequest('Globex'));
    expect(await service.listFor(owner)).toHaveLength(1);
    expect(await service.listFor(admin)).toHaveLength(2);
  });
});

describe('InstanceService.retry', () => {
  it('allows an owner to retry their failed provisioning job', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    const job = await store.findLatestJobForInstance(instance.id);
    await store.failJob(job!.id, 'bench failed');
    await store.updateInstance(instance.id, { status: 'failed' });
    const retried = await service.retry(owner, instance.id);
    expect(retried.status).toBe('queued');
  });

  it('does not allow another owner to retry the instance', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
    const job = await store.findLatestJobForInstance(instance.id);
    await store.failJob(job!.id, 'bench failed');
    await store.updateInstance(instance.id, { status: 'failed' });
    await expect(service.retry(other, instance.id)).rejects.toThrow(NotFoundError);
  });

  it('re-queues a failed instance', async () => {
    const instance = await service.create(owner, createRequest('Acme Corp'));
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
    const instance = await service.create(owner, createRequest('Acme Corp'));
    await store.updateInstance(instance.id, { status: 'provisioning' });
    await expect(service.retry(admin, instance.id)).rejects.toThrow(ValidationError);
  });
});
