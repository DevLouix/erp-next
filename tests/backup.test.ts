import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, loginAs, type TestApp } from './helpers/app.js';

let active: TestApp[] = [];

async function app(): Promise<TestApp> {
  const ctx = await makeTestApp();
  active.push(ctx);
  return ctx;
}

afterEach(async () => {
  await Promise.all(active.map((c) => c.app.close()));
  active = [];
});

async function exportSnapshot(ctx: TestApp, cookie: string): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/backup/export',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('backup export', () => {
  it('is admin-only', async () => {
    const ctx = await app();
    const user = await loginAs(ctx, { sub: 'plain', email: 'plain@example.test' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/backup/export',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('includes users, instances and jobs but never sessions or tokens', async () => {
    const ctx = await app();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(ctx, { sub: 'alice', email: 'alice@example.test' });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });

    const snapshot = await exportSnapshot(ctx, admin.cookie);
    expect(snapshot.app).toBe('erp-next-platform');
    expect((snapshot.users as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((snapshot.instances as unknown[]).length).toBe(1);
    expect((snapshot.jobs as unknown[]).length).toBe(1);

    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('accessToken');
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('refreshToken');
  });

  it('stores a backup that can be listed and downloaded', async () => {
    const ctx = await app();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/backup',
      headers: { cookie: admin.cookie },
      payload: { label: 'nightly' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().backup.id;

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/backup',
      headers: { cookie: admin.cookie },
    });
    expect(list.json().backups).toHaveLength(1);

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/backup/${id}/download`,
      headers: { cookie: admin.cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().app).toBe('erp-next-platform');
  });

  it('lets administrators select automatic and S3-compatible tenant backup settings', async () => {
    const ctx = await app();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const updated = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: admin.cookie },
      payload: {
        automaticEnabled: true,
        intervalHours: 24,
        s3Endpoint: 'https://objects.example.test',
        s3Bucket: 'erpnext-backups',
        s3Region: 'us-east-1',
        s3AccessKeyId: 'test-access-key',
        s3SecretAccessKey: 'test-secret-key',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings.automaticEnabled).toBe(true);
    expect(updated.json().settings.s3Endpoint).toBe('https://objects.example.test');
    expect(updated.json().settings.s3CredentialsConfigured).toBe(true);
    expect(JSON.stringify(updated.json())).not.toContain('test-access-key');
    expect(JSON.stringify(updated.json())).not.toContain('test-secret-key');
    expect(updated.json().settings.nextRunAt).toBeTruthy();
    const encrypted = await ctx.store.getSiteBackupCredentials();
    expect(encrypted?.accessKeyCiphertext).not.toContain('test-access-key');
    expect(encrypted?.secretKeyCiphertext).not.toContain('test-secret-key');

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: admin.cookie },
    });
    expect(read.json().settings.s3CredentialsConfigured).toBe(true);
    expect(JSON.stringify(read.json())).not.toContain('test-secret-key');
  });

  it('preserves saved credentials when settings are edited and supports clearing them', async () => {
    const ctx = await app();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const base = {
      automaticEnabled: false,
      intervalHours: 24,
      s3Endpoint: null,
      s3Bucket: null,
      s3Region: null,
    };
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: admin.cookie },
      payload: { ...base, s3AccessKeyId: 'keep-me', s3SecretAccessKey: 'also-keep-me' },
    });
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: admin.cookie },
      payload: { ...base, intervalHours: 168 },
    });
    expect((await ctx.store.getSiteBackupSettings()).s3CredentialsConfigured).toBe(true);

    const cleared = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: admin.cookie },
      payload: { ...base, intervalHours: 168, clearS3Credentials: true },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings.s3CredentialsConfigured).toBe(false);
    expect(await ctx.store.getSiteBackupCredentials()).toBeNull();
  });

  it('does not allow regular users to configure backup policy', async () => {
    const ctx = await app();
    const user = await loginAs(ctx, { sub: 'plain', email: 'plain@example.test' });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/site-backup-settings',
      headers: { cookie: user.cookie },
      payload: {
        automaticEnabled: true,
        intervalHours: 24,
        s3Endpoint: null,
        s3Bucket: null,
        s3Region: null,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('restore onto another instance', () => {
  it('restores users, ownership and instances, and re-queues incomplete sites', async () => {
    // Source deployment.
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(source, { sub: 'alice', email: 'alice@example.test' });
    const created = await source.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });
    const sourceSiteName = created.json().instance.siteName;
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);

    // Target deployment (fresh database).
    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const imported = await target.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: targetAdmin.cookie },
      payload: { snapshot, dryRun: false },
    });
    expect(imported.statusCode).toBe(200);
    const summary = imported.json().summary;
    expect(summary.instances.created).toBe(1);
    expect(summary.jobsRequeued).toBe(1);

    // Alice is restored as a user and owns her site on the new deployment.
    const targetAlice = await loginAs(target, { sub: 'alice', email: 'alice@example.test' });
    const list = await target.app.inject({
      method: 'GET',
      url: '/api/instances',
      headers: { cookie: targetAlice.cookie },
    });
    expect(list.json().instances).toHaveLength(1);
    expect(list.json().instances[0].siteName).toBe(sourceSiteName);

    const job = await target.store.findLatestJobForInstance(list.json().instances[0].id);
    expect(job?.status).toBe('queued');
  });

  it('does not mutate on a dry run', async () => {
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);

    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const before = await target.store.countUsers();
    const res = await target.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: targetAdmin.cookie },
      payload: { snapshot, dryRun: true },
    });
    expect(res.json().summary.dryRun).toBe(true);
    // Only the admin that logged in exists; dry run added nothing.
    expect(await target.store.countUsers()).toBe(before);
  });

  it('is idempotent — importing twice creates no duplicates', async () => {
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(source, { sub: 'alice', email: 'alice@example.test' });
    await source.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);

    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    for (let i = 0; i < 2; i += 1) {
      await target.app.inject({
        method: 'POST',
        url: '/api/admin/backup/import',
        headers: { cookie: targetAdmin.cookie },
        payload: { snapshot, dryRun: false },
      });
    }
    expect(await target.store.listAllInstances()).toHaveLength(1);
    const aliceCount = (await target.store.listUsers()).filter((u) => u.oauthSubject === 'alice');
    expect(aliceCount).toHaveLength(1);
  });

  it('rejects a malformed backup', async () => {
    const ctx = await app();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: admin.cookie },
      payload: { snapshot: { app: 'not-us', users: [] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rewrites site hostnames when a base domain override is supplied', async () => {
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(source, { sub: 'alice', email: 'alice@example.test' });
    await source.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);

    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    await target.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: targetAdmin.cookie },
      payload: { snapshot, dryRun: false, baseDomainOverride: 'new.example.test' },
    });
    const instances = await target.store.listAllInstances();
    expect(instances[0]?.hostname).toBe('acme-corp.new.example.test');
    expect(instances[0]?.siteName).toBe('acme-corp.new.example.test');
  });

  it('does not requeue a snapshot captured during permanent deletion', async () => {
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(source, { sub: 'alice', email: 'alice@example.test' });
    const created = await source.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });
    await source.store.updateInstance(created.json().instance.id, { status: 'deleting' });
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);

    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const imported = await target.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: targetAdmin.cookie },
      payload: { snapshot, dryRun: false },
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json().summary.jobsRequeued).toBe(0);
    const instances = await target.store.listAllInstances();
    expect(instances[0]?.status).toBe('failed');
    expect(instances[0]?.errorMessage).toContain('captured during permanent deletion');
    expect(await target.store.findLatestJobForInstance(instances[0]!.id)).toBeNull();
  });

  it('supports older snapshots without a company display name', async () => {
    const source = await app();
    const sourceAdmin = await loginAs(source, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const alice = await loginAs(source, { sub: 'alice', email: 'alice@example.test' });
    await source.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
      payload: { name: 'Acme Corp' },
    });
    const snapshot = await exportSnapshot(source, sourceAdmin.cookie);
    delete (snapshot.instances as Array<Record<string, unknown>>)[0]!.companyName;

    const target = await app();
    const targetAdmin = await loginAs(target, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const imported = await target.app.inject({
      method: 'POST',
      url: '/api/admin/backup/import',
      headers: { cookie: targetAdmin.cookie },
      payload: { snapshot, dryRun: false },
    });

    expect(imported.statusCode).toBe(200);
    const instance = (await target.store.listAllInstances())[0];
    expect(instance?.companyName).toBe('acme-corp');
  });
});
