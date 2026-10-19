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

describe('dashboard presentation', () => {
  it('links hostnames externally, styles Manage, and disables Retry while provisioning', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;

    const dashboard = await ctx.app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain(`href="https://${instance.hostname}"`);
    expect(dashboard.body).toContain('class="external-link-icon"');
    expect(dashboard.body).toContain('class="manage-link"');
    expect(dashboard.body).toContain('data-theme-toggle');
    expect(dashboard.body).toContain("localStorage.setItem('erpnext-hosting-theme'");
    expect(dashboard.body).toContain('class="brand"');
    expect(dashboard.body).toContain('--bg: #f7f6f2');
    expect(dashboard.body).toContain('backdrop-filter: blur(16px)');
    expect(dashboard.body).toContain('@media (max-width: 700px)');
    expect(dashboard.body).toContain("prefers-color-scheme: dark");
    expect(dashboard.body).toContain('name="adminPassword"');
    expect(dashboard.body).toContain('name="confirmAdminPassword"');
    expect(dashboard.body).toContain('data-password-generate');
    expect(dashboard.body).toContain('data-password-meter');
    expect(dashboard.body).toContain('aria-controls="adminPassword"');
    expect(dashboard.body).toContain('Passwords do not match yet.');
    expect(dashboard.body).toContain('reportValidity()');

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}`,
      headers: { cookie },
    });

    expect(detail.body).toContain('Retry provisioning');
    expect(detail.body).toMatch(/Retry provisioning<\/button>/);
    expect(detail.body).toContain('disabled>Retry provisioning</button>');
    expect(detail.body).toContain('<a class="dashboard-back-link" href="/dashboard">Back to dashboard</a>');
  });

  it('returns a helpful dashboard message for mismatched creation passwords', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/dashboard/instances',
      headers: { cookie },
      payload: {
        name: 'Acme Manufacturing',
        adminPassword: 'secure-test-password',
        confirmAdminPassword: 'different-test-password',
      },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toContain(encodeURIComponent('Administrator passwords do not match'));
    expect(response.headers.location).not.toContain('secure-test-password');
  });

  it('shows recovery and password management for a ready instance without rendering the secret', async () => {
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
    await ctx.store.completeJob((await ctx.store.findLatestJobForInstance(instance.id))!.id);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}`,
      headers: { cookie },
    });
    expect(detail.body).toContain('ERPNext login');
    expect(detail.body).toContain('Administrator');
    expect(detail.body).toContain('Show saved password');
    expect(detail.body).toContain('Change password');
    expect(detail.body).not.toContain('secure-test-password');

    const changed = await ctx.app.inject({
      method: 'POST',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}/credentials`,
      headers: { cookie },
      payload: {
        adminPassword: 'another-secure-password',
        confirmAdminPassword: 'another-secure-password',
      },
    });
    expect(changed.statusCode).toBe(303);
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('credentials');
  });

  it('shows a helpful inline-page error when changed passwords do not match', async () => {
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
    await ctx.store.completeJob((await ctx.store.findLatestJobForInstance(instance.id))!.id);

    const changed = await ctx.app.inject({
      method: 'POST',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}/credentials`,
      headers: { cookie },
      payload: {
        adminPassword: 'another-secure-password',
        confirmAdminPassword: 'different-secure-password',
      },
    });
    expect(changed.statusCode).toBe(303);
    expect(changed.headers.location).toContain(encodeURIComponent('Administrator passwords do not match'));
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('provision');
  });

  it('guides the owner through custom-domain DNS verification and queues Frappe setup', async () => {
    ctx = await makeTestApp({}, {
      resolveTxt: async () => {
        const instance = await ctx.store.findInstanceByCustomDomain('erp.acme.com');
        return [[`erpnext-domain-verification=${instance?.customDomainVerificationToken}`]];
      },
    });
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    await ctx.store.updateInstance(instance.id, { status: 'ready' });
    await ctx.store.completeJob((await ctx.store.findLatestJobForInstance(instance.id))!.id);

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}/domains`,
      headers: { cookie },
      payload: { domain: 'ERP.Acme.com.' },
    });
    expect(added.statusCode).toBe(303);
    const saved = await ctx.store.findInstanceById(instance.id);
    expect(saved?.customDomain).toBe('erp.acme.com');
    expect(saved?.customDomainStatus).toBe('pending');

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}`,
      headers: { cookie },
    });
    expect(detail.body).toContain(`_erpnext-verification.erp.acme.com`);
    expect(detail.body).toContain('before any traffic is routed');

    const verified = await ctx.app.inject({
      method: 'POST',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}/domains/verify`,
      headers: { cookie },
    });
    expect(verified.statusCode).toBe(303);
    expect((await ctx.store.findInstanceById(instance.id))?.customDomainStatus).toBe('configuring');
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.type).toBe('domain');
  });

  it('enables Retry after the provisioning job fails', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    const job = await ctx.store.findLatestJobForInstance(instance.id);
    if (!job) throw new Error('Expected instance provisioning job');
    await ctx.store.failJob(job.id, 'Provisioning failed');
    await ctx.store.updateInstance(instance.id, {
      status: 'failed',
      errorMessage: 'Provisioning failed',
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('Retry provisioning</button>');
    expect(detail.body).not.toContain('disabled>Retry provisioning</button>');
  });

  it('keeps the admin Retry action disabled until a provisioning job fails', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, {
      sub: 'admin',
      email: 'admin@example.test',
      role: 'platform-admin',
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    const adminPage = () => ctx.app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie },
    });

    const inProgress = await adminPage();
    expect(inProgress.statusCode).toBe(200);
    expect(inProgress.body).toContain('disabled>Retry</button>');

    const job = await ctx.store.findLatestJobForInstance(instance.id);
    if (!job) throw new Error('Expected instance provisioning job');
    await ctx.store.failJob(job.id, 'Provisioning failed');
    await ctx.store.updateInstance(instance.id, {
      status: 'failed',
      errorMessage: 'Provisioning failed',
    });

    const failed = await adminPage();
    expect(failed.body).toContain('>Retry</button>');
    expect(failed.body).not.toContain('disabled>Retry</button>');
  });

  it('lets an owner stop an active provisioning job', async () => {
    ctx = await makeTestApp();
    const { cookie } = await loginAs(ctx, { sub: 'owner', email: 'owner@example.test' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: createPayload('Acme Manufacturing'),
    });
    const instance = created.json().instance;
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}`,
      headers: { cookie },
    });
    expect(detail.body).toContain('Stop provisioning');

    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/dashboard/instances/${encodeURIComponent(instance.id)}/stop`,
      headers: { cookie },
    });

    expect(stopped.statusCode).toBe(303);
    expect((await ctx.store.findInstanceById(instance.id))?.status).toBe('failed');
    expect((await ctx.store.findLatestJobForInstance(instance.id))?.status).toBe('failed');
  });
});
