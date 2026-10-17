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
});
