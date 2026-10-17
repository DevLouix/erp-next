import type { FastifyInstance } from 'fastify';
import type { UserInfo } from '@truemoi/sdk';
import { buildApp } from '../../src/app.js';
import { testConfig, type AppConfig } from '../../src/config.js';
import { MemoryStore } from '../../src/domain/memoryStore.js';
import { FakeIdentityProvider } from './fakes.js';

export interface TestApp {
  app: FastifyInstance;
  store: MemoryStore;
  identity: FakeIdentityProvider;
  config: AppConfig;
}

export async function makeTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const config = testConfig(overrides);
  const store = new MemoryStore();
  const identity = new FakeIdentityProvider();
  const { app } = await buildApp({ config, store, identity });
  await app.ready();
  return { app, store, identity, config };
}

function extractCookie(setCookie: string | string[] | undefined, name: string): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const pair = value.split(';')[0];
    if (pair && pair.startsWith(`${name}=`)) return pair;
  }
  throw new Error(`Cookie ${name} not set`);
}

/** Drive a full OAuth login and return the session cookie header value. */
export async function loginAs(
  ctx: TestApp,
  user: UserInfo,
): Promise<{ cookie: string; userId: string }> {
  ctx.identity.currentUser = user;

  const loginRes = await ctx.app.inject({ method: 'GET', url: '/auth/login' });
  if (loginRes.statusCode !== 302) {
    throw new Error(`login did not redirect: ${loginRes.statusCode}`);
  }
  const location = loginRes.headers.location as string;
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('no state in redirect');

  const callbackRes = await ctx.app.inject({
    method: 'GET',
    url: `/auth/callback?code=code-${state}&state=${encodeURIComponent(state)}`,
  });
  if (callbackRes.statusCode !== 302) {
    throw new Error(`callback failed: ${callbackRes.statusCode} ${callbackRes.body}`);
  }
  const cookie = extractCookie(
    callbackRes.headers['set-cookie'] as string | string[],
    ctx.config.SESSION_COOKIE_NAME,
  );

  const dbUser = await ctx.store.findUserByOauthSubject(user.sub);
  if (!dbUser) throw new Error('user was not created');
  return { cookie, userId: dbUser.id };
}
