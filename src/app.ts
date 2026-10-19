import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { AppConfig } from './config.js';
import type { Store } from './domain/store.js';
import { AuthService } from './auth/authService.js';
import type { IdentityProvider } from './auth/identityProvider.js';
import { registerAuthDecorators, registerAuthHook, registerOriginCheck } from './auth/middleware.js';
import { InstanceService, type CustomDomainDns } from './instances/instanceService.js';
import { AdminService } from './admin/adminService.js';
import { BackupService } from './admin/backupService.js';
import { SiteBackupService } from './admin/siteBackupService.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAuthRoutes } from './http/routes/authRoutes.js';
import { registerInstanceRoutes } from './http/routes/instanceRoutes.js';
import { registerAdminRoutes } from './http/routes/adminRoutes.js';
import { registerWebRoutes } from './http/routes/webRoutes.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  identity: IdentityProvider;
  domainDns?: CustomDomainDns;
}

export interface AppContext {
  app: FastifyInstance;
  authService: AuthService;
  instanceService: InstanceService;
  adminService: AdminService;
  backupService: BackupService;
  siteBackupService: SiteBackupService;
}

/**
 * Compose the HTTP application. All I/O dependencies are injected so the whole
 * app can be exercised in tests against an in-memory store and a fake identity
 * provider.
 */
export async function buildApp(deps: AppDeps): Promise<AppContext> {
  const { config, store, identity } = deps;
  const app = Fastify({
    logger: config.isTest || config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await app.register(formbody);

  const authService = new AuthService(store, config, identity);
  const instanceService = new InstanceService(store, config, deps.domainDns);
  const adminService = new AdminService(store, instanceService, config);
  const backupService = new BackupService(store, config);
  const siteBackupService = new SiteBackupService(store, instanceService, config);

  registerAuthDecorators(app);
  registerOriginCheck(app, config);
  registerAuthHook(app, authService, config);
  registerErrorHandler(app);

  registerAuthRoutes(app, authService, config);
  registerInstanceRoutes(app, instanceService, siteBackupService, config);
  registerAdminRoutes(app, adminService, backupService, siteBackupService, config);
  registerWebRoutes(app, {
    config,
    store,
    instanceService,
    adminService,
    backupService,
    siteBackupService,
  });

  return { app, authService, instanceService, adminService, backupService, siteBackupService };
}
