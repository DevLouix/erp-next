import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, loginAs, type TestApp } from './helpers/app.js';

let ctx: TestApp;
const createPayload = (name: string) => ({
  name,
  adminPassword: 'secure-test-password',
  confirmAdminPassword: 'secure-test-password',
});

afterEach(async () => {
  await ctx?.app.close();
});

describe('POST /api/instances', () => {
  it('creates a queued instance and enqueues a job', async () => {
    ctx = await makeTestApp();
    const { cookie, userId } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });

    expect(res.statusCode).toBe(201);
    const { instance } = res.json();
    expect(instance.status).toBe('queued');
    expect(instance.hostname).toBe('acme-manufacturing.apps.example.test');
    expect(instance.url).toBeNull();

    const jobs = await ctx.store.findLatestJobForInstance(instance.id);
    expect(jobs?.status).toBe('queued');
    expect(instance.ownerUserId).toBe(userId);
  });

  it('requires a confirmed Administrator password and never returns it in instance metadata', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: { name: 'Acme Manufacturing' },
    });
    expect(missing.statusCode).toBe(400);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('secure-test-password');
  });

  it('recovers and changes ready-instance credentials only for an authorized owner', async () => {
    ctx = await makeTestApp();
    const owner = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const other = await loginAs(ctx, { sub: 'other', email: 'other@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: owner.cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    await ctx.store.updateInstance(instance.id, { status: 'ready' });
    const provisioningJob = await ctx.store.findLatestJobForInstance(instance.id);
    await ctx.store.completeJob(provisioningJob!.id);

    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/credentials`,
      headers: { cookie: other.cookie },
    });
    expect(denied.statusCode).toBe(404);

    const recovered = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/credentials`,
      headers: { cookie: owner.cookie },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers['cache-control']).toContain('no-store');
    expect(recovered.json().credentials).toEqual({
      username: 'Administrator',
      password: 'secure-test-password',
    });

    const changed = await ctx.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/credentials`,
      headers: { cookie: owner.cookie },
      payload: {
        adminPassword: 'another-secure-password',
        confirmAdminPassword: 'another-secure-password',
      },
    });
    expect(changed.statusCode).toBe(202);
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('credentials');
  });

  it('rejects an invalid site name with 400', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('ab'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('requires a name', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('honours the Idempotency-Key header (duplicate-request protection)', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const headers = { cookie, 'idempotency-key': 'req-42' };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: createPayload('Acme Manufacturing'),
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers,
      payload: createPayload('Acme Manufacturing'),
    });
    expect(first.json().instance.id).toBe(second.json().instance.id);
    expect(await ctx.store.listAllInstances()).toHaveLength(1);
  });

  it('gives two customers distinct hostnames for the same company name', async () => {
    ctx = await makeTestApp();
    const a = await loginAs(ctx, { sub: 'a', email: 'a@example.test' });
    const b = await loginAs(ctx, { sub: 'b', email: 'b@example.test' });
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: a.cookie },
      payload: createPayload('Globex'),
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: b.cookie },
      payload: createPayload('Globex'),
    });
    expect(first.json().instance.hostname).not.toBe(second.json().instance.hostname);
  });

  it('reports a ready instance with its URL', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Ready Co'),
    });
    const id = created.json().instance.id;
    await ctx.store.updateInstance(id, { status: 'ready' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${id}`,
      headers: { cookie },
    });
    expect(res.json().instance.url).toBe('https://ready-co.apps.example.test');
  });

  it('updates the display name without changing the Frappe site address', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/instances/${instance.id}`,
      headers: { cookie },
      payload: { name: 'Acme Global' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().instance.companyName).toBe('Acme Global');
    expect(updated.json().instance.hostname).toBe(instance.hostname);
  });

  it('lets the owner retry a failed provisioning job', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    const job = await ctx.store.findLatestJobForInstance(instance.id);
    await ctx.store.failJob(job!.id, 'provisioning failed');
    await ctx.store.updateInstance(instance.id, {
      status: 'failed',
      errorMessage: 'provisioning failed',
    });

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/retry`,
      headers: { cookie },
    });

    expect(retry.statusCode).toBe(202);
    expect(retry.json().instance.status).toBe('queued');
    expect(retry.json().instance.errorMessage).toBeNull();
    const retriedJob = await ctx.store.findLatestJobForInstance(instance.id);
    expect(retriedJob?.type).toBe('provision');
    expect(retriedJob?.status).toBe('queued');
    expect(retriedJob?.attempts).toBe(0);
  });

  it('does not let an unrelated owner retry another tenant instance', async () => {
    ctx = await makeTestApp();
    const owner = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const other = await loginAs(ctx, { sub: 'other', email: 'other@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: owner.cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const id = created.json().instance.id;
    const job = await ctx.store.findLatestJobForInstance(id);
    await ctx.store.failJob(job!.id, 'provisioning failed');
    await ctx.store.updateInstance(id, { status: 'failed', errorMessage: 'provisioning failed' });

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/instances/${id}/retry`,
      headers: { cookie: other.cookie },
    });

    expect(retry.statusCode).toBe(404);
    expect((await ctx.store.findInstanceById(id))?.status).toBe('failed');
  });

  it('requires the exact hostname before queuing destructive deletion', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    await ctx.store.updateInstance(instance.id, { status: 'ready' });
    const provisioningJob = await ctx.store.findLatestJobForInstance(instance.id);
    await ctx.store.completeJob(provisioningJob!.id);

    const rejected = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/instances/${instance.id}`,
      headers: { cookie },
      payload: { confirmSiteName: 'wrong-site' },
    });
    expect(rejected.statusCode).toBe(400);
    expect((await ctx.store.findInstanceById(instance.id))?.status).toBe('ready');

    const accepted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/instances/${instance.id}`,
      headers: { cookie },
      payload: { confirmSiteName: instance.hostname },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().instance.status).toBe('deleting');
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('delete');
  });

  it('queues a full-site backup only for an instance the caller can access', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'u1', email: 'u1@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    await ctx.store.updateInstance(instance.id, { status: 'ready' });
    const provisioningJob = await ctx.store.findLatestJobForInstance(instance.id);
    await ctx.store.completeJob(provisioningJob!.id);

    const queued = await ctx.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/backups`,
      headers: { cookie },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().backup.status).toBe('queued');
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('backup');
    const backupId = queued.json().backup.id;
    await ctx.store.updateSiteBackup(backupId, {
      parts: [
        { kind: 'database', relativePath: 'site/database.sql.gz', sizeBytes: 1 },
        { kind: 'public-files', relativePath: 'site/files.tar', sizeBytes: 1 },
        { kind: 'private-files', relativePath: 'site/private-files.tar', sizeBytes: 1 },
        { kind: 'site-config', relativePath: 'site/site_config_backup.json', sizeBytes: 1 },
      ],
    });

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${instance.id}/backups`,
      headers: { cookie },
    });
    expect(listed.json().backups).toHaveLength(1);
    expect(listed.json().backups[0].parts.map((part: { kind: string }) => part.kind)).toEqual([
      'database',
      'public-files',
      'private-files',
    ]);
    const restrictedConfig = await ctx.app.inject({
      method: 'GET',
      url: `/api/site-backups/${backupId}/files/site-config`,
      headers: { cookie },
    });
    expect(restrictedConfig.statusCode).toBe(404);
  });
});

describe('custom-domain DNS instructions', () => {
  it('returns the assigned hostname as the custom-domain CNAME target', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    await ctx.store.updateInstance(instance.id, { status: 'ready' });

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/instances/${instance.id}/domains`,
      headers: { cookie },
      payload: { domain: 'erp.acme.com' },
    });

    expect(added.statusCode).toBe(201);
    expect(added.json().dnsRouting.cnameTarget).toBe(instance.hostname);
    expect(added.json().dnsVerification.txtName).toBe('_erpnext-verification.erp.acme.com');
  });
});
