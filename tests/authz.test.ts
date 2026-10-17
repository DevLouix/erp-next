import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, loginAs, type TestApp } from './helpers/app.js';

let ctx: TestApp;

afterEach(async () => {
  await ctx?.app.close();
});

async function createInstance(cookie: string, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/instances',
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().instance.id;
}

describe('cross-customer isolation', () => {
  it('keeps one customer from reading another customer instance', async () => {
    ctx = await makeTestApp();
    const alice = await loginAs(ctx, { sub: 'alice', email: 'alice@example.test' });
    const bob = await loginAs(ctx, { sub: 'bob', email: 'bob@example.test' });

    const aliceInstance = await createInstance(alice.cookie, 'Alice Corp');

    // Bob cannot read Alice's instance...
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${aliceInstance}`,
      headers: { cookie: bob.cookie },
    });
    expect(denied.statusCode).toBe(404);

    // ...and Bob's list does not include it.
    const bobList = await ctx.app.inject({
      method: 'GET',
      url: '/api/instances',
      headers: { cookie: bob.cookie },
    });
    expect(bobList.json().instances).toHaveLength(0);

    // Alice can still see her own.
    const aliceList = await ctx.app.inject({
      method: 'GET',
      url: '/api/instances',
      headers: { cookie: alice.cookie },
    });
    expect(aliceList.json().instances).toHaveLength(1);
  });

  it('denies admin endpoints to non-admins', async () => {
    ctx = await makeTestApp();
    const user = await loginAs(ctx, { sub: 'plain', email: 'plain@example.test' });
    for (const url of ['/api/admin/users', '/api/admin/instances', '/api/admin/audit']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lets an admin see all instances and retry a failed one', async () => {
    ctx = await makeTestApp();
    const alice = await loginAs(ctx, { sub: 'alice', email: 'alice@example.test' });
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });

    const id = await createInstance(alice.cookie, 'Alice Corp');
    const job = await ctx.store.findLatestJobForInstance(id);
    await ctx.store.failJob(job!.id, 'bench failed');
    await ctx.store.updateInstance(id, { status: 'failed', errorMessage: 'bench failed' });

    const all = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/instances',
      headers: { cookie: admin.cookie },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().instances).toHaveLength(1);

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/instances/${id}/retry`,
      headers: { cookie: admin.cookie },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().instance.status).toBe('queued');
  });

  it('lets an admin disable a user and immediately revokes their session', async () => {
    ctx = await makeTestApp();
    const admin = await loginAs(ctx, {
      sub: 'root',
      email: 'root@example.test',
      role: 'platform-admin',
    });
    const victim = await loginAs(ctx, { sub: 'victim', email: 'victim@example.test' });

    const disable = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${victim.userId}/disabled`,
      headers: { cookie: admin.cookie },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(200);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/instances',
      headers: { cookie: victim.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
