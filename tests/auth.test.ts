import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, loginAs, type TestApp } from './helpers/app.js';

let ctx: TestApp;

afterEach(async () => {
  await ctx?.app.close();
});

describe('OAuth login flow', () => {
  it('redirects to the identity provider on /auth/login', async () => {
    ctx = await makeTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://idp.example.test/auth');
    expect(res.headers.location).toContain('state=');
  });

  it('creates the user and a session on a valid callback', async () => {
    ctx = await makeTestApp();
    const { cookie, userId } = await loginAs(ctx, {
      sub: 'abc-123',
      email: 'jane@example.test',
      name: 'Jane',
      role: 'user',
    });
    expect(cookie).toContain(ctx.config.SESSION_COOKIE_NAME);
    const user = await ctx.store.findUserById(userId);
    expect(user?.oauthSubject).toBe('abc-123');
    expect(user?.email).toBe('jane@example.test');
    expect(user?.role).toBe('user');
  });

  it('rejects a callback with an unknown state', async () => {
    ctx = await makeTestApp();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/callback?code=whatever&state=not-a-real-state',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/login?error=');
  });

  it('rejects a replayed callback (state is single-use)', async () => {
    ctx = await makeTestApp();
    ctx.identity.currentUser = { sub: 'abc-123', email: 'jane@example.test' };
    const loginRes = await ctx.app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state')!;
    const callbackUrl = `/auth/callback?code=code-${state}&state=${encodeURIComponent(state)}`;

    const first = await ctx.app.inject({ method: 'GET', url: callbackUrl });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/dashboard');

    const second = await ctx.app.inject({ method: 'GET', url: callbackUrl });
    expect(second.headers.location).toContain('/login?error=');
  });

  it('derives admin role from the Truemoi role claim', async () => {
    ctx = await makeTestApp();
    const { userId } = await loginAs(ctx, {
      sub: 'admin-1',
      email: 'admin@example.test',
      role: 'platform-admin',
    });
    const user = await ctx.store.findUserById(userId);
    expect(user?.role).toBe('admin');
  });

  it('rejects a disabled account at login', async () => {
    ctx = await makeTestApp();
    const { userId } = await loginAs(ctx, { sub: 'banned', email: 'banned@example.test' });
    await ctx.store.updateUser(userId, { disabled: true });
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(302);
    // The transaction began; completing it should now fail because the account is disabled.
    const state = new URL(res.headers.location as string).searchParams.get('state')!;
    const callback = await ctx.app.inject({
      method: 'GET',
      url: `/auth/callback?code=code-${state}&state=${encodeURIComponent(state)}`,
    });
    expect(callback.headers.location).toContain('/login?error=');
  });
});

describe('session protection', () => {
  it('rejects unauthenticated API access with 401', async () => {
    ctx = await makeTestApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/instances' })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Acme' } }))
        .statusCode,
    ).toBe(401);
  });

  it('rejects cross-origin state-changing requests', async () => {
    ctx = await makeTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { origin: 'https://evil.example.test' },
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not trust a user id supplied by the client', async () => {
    ctx = await makeTestApp();
    const a = await loginAs(ctx, { sub: 'user-a', email: 'a@example.test' });
    const b = await loginAs(ctx, { sub: 'user-b', email: 'b@example.test' });
    // Create via A, then attempt to read as B by supplying A's owner id in a header.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie: a.cookie, 'x-user-id': b.userId },
      payload: { name: 'Acme' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().instance.id;

    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/instances/${id}`,
      headers: { cookie: b.cookie, 'x-user-id': a.userId },
    });
    expect(read.statusCode).toBe(404);
  });
});
