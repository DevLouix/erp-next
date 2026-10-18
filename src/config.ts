import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * Everything is sourced from the environment. Nothing here has a secret baked
 * in, and the loader is pure so it can be unit-tested with a plain object.
 */

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const boolString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const intString = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : Number.parseInt(v, 10)))
    .refine((n) => Number.isFinite(n), 'must be an integer');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intString(3000),
  PUBLIC_BASE_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  BACKUP_CREDENTIALS_ENCRYPTION_KEY: z.string().min(1),
  HEALTHCHECK_BASE_URL: z.string().url().optional(),

  SESSION_COOKIE_SECRET: z.string().min(32, 'SESSION_COOKIE_SECRET must be at least 32 characters'),
  SESSION_COOKIE_NAME: z.string().default('erpnext_platform_session'),
  SESSION_TTL_HOURS: intString(24 * 7),
  COOKIE_SECURE: boolString(false),

  TRUEMOI_CLIENT_ID: z.string().min(1),
  TRUEMOI_CLIENT_SECRET: z.string().optional(),
  TRUEMOI_AUTH_DOMAIN: z.string().min(1),
  TRUEMOI_API_URL: z.string().url().default('https://api.truemoi.com'),
  TRUEMOI_AUTH_REALM: z.string().default('truemoi'),
  TRUEMOI_SCOPES: z.string().default('openid email profile offline_access'),
  TRUEMOI_ADMIN_ROLES: csv,
  ADMIN_EMAILS: csv,

  PROVISIONING_BASE_DOMAIN: z.string().min(1),
  BENCH_PATH: z.string().default('/home/frappe/frappe-bench'),
  BENCH_BIN: z.string().default('bench'),
  MARIADB_ROOT_PASSWORD: z.string().min(1),
  MARIADB_HOST: z.string().optional(),
  ERPNEXT_ADMIN_PASSWORD: z.string().min(1),
  ERP_NEXT_VERSION: z.string().optional(),

  PROVISION_MAX_ATTEMPTS: intString(5),
  PROVISION_LOCK_TIMEOUT_MS: intString(15 * 60 * 1000),
  // How to treat a failure of `bench setup nginx`:
  //   strict      — fail the attempt (single host where bench owns nginx)
  //   best-effort — log and continue; the health check is the real gate
  //   skip        — do not regenerate nginx at all
  PROVISION_ROUTING_MODE: z.enum(['strict', 'best-effort', 'skip']).default('best-effort'),
  WORKER_POLL_INTERVAL_MS: intString(3000),
  HEALTHCHECK_TIMEOUT_MS: intString(120_000),
  HEALTHCHECK_INTERVAL_MS: intString(5000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  const data = parsed.data;
  const explicitSecure = env.COOKIE_SECURE !== undefined;
  return {
    ...data,
    // Default to secure cookies in production unless explicitly overridden.
    COOKIE_SECURE: explicitSecure ? data.COOKIE_SECURE : data.NODE_ENV === 'production',
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
  };
}

/** Build a config object for tests without requiring a full environment. */
export function testConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://erpnext:erpnext@localhost:5433/erpnext_platform_test',
    SESSION_COOKIE_SECRET: 'test-secret-test-secret-test-secret-32',
    BACKUP_CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    COOKIE_SECURE: 'false',
    TRUEMOI_CLIENT_ID: 'test-client',
    TRUEMOI_AUTH_DOMAIN: 'auth.example.test',
    TRUEMOI_API_URL: 'https://api.example.test',
    TRUEMOI_ADMIN_ROLES: 'platform-admin,admin',
    ADMIN_EMAILS: 'root@example.test',
    PROVISIONING_BASE_DOMAIN: 'apps.example.test',
    MARIADB_ROOT_PASSWORD: 'root-pw',
    ERPNEXT_ADMIN_PASSWORD: 'admin-pw',
  } as NodeJS.ProcessEnv);
  return { ...base, ...(overrides as Partial<AppConfig>) };
}
