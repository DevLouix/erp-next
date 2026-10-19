import 'dotenv/config';
import { loadConfig } from './config.js';
import { getPrisma, disconnectPrisma } from './db/prisma.js';
import { PrismaStore } from './domain/prismaStore.js';
import { ExecFileRunner } from './provisioning/commands.js';
import { BenchClient } from './provisioning/bench.js';
import { waitForHealthy } from './provisioning/health.js';
import { ProvisioningWorker, type HealthWaiter } from './provisioning/worker.js';
import { TraefikFileIngress } from './provisioning/domainIngress.js';
import { consoleLogger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  const store = new PrismaStore(prisma);

  const runner = new ExecFileRunner();
  const bench = new BenchClient(runner, {
    benchBin: config.BENCH_BIN,
    benchPath: config.BENCH_PATH,
    mariadbRootPassword: config.MARIADB_ROOT_PASSWORD,
    erpnextAdminPassword: config.ERPNEXT_ADMIN_PASSWORD,
    mariadbHost: config.MARIADB_HOST,
    erpnextApp: 'erpnext',
  });

  const health: HealthWaiter = {
    waitForHealthy: (hostname) =>
      waitForHealthy(hostname, {
        timeoutMs: config.HEALTHCHECK_TIMEOUT_MS,
        intervalMs: config.HEALTHCHECK_INTERVAL_MS,
        baseUrl: config.HEALTHCHECK_BASE_URL,
      }),
  };

  const domainIngress = config.CUSTOM_DOMAIN_INGRESS_MODE === 'traefik-file'
    ? new TraefikFileIngress({
        routesDir: config.CUSTOM_DOMAIN_ROUTES_DIR,
        upstreamUrl: config.CUSTOM_DOMAIN_UPSTREAM_URL,
        certResolver: config.CUSTOM_DOMAIN_CERT_RESOLVER,
        httpEntryPoint: config.CUSTOM_DOMAIN_HTTP_ENTRYPOINT,
        httpsEntryPoint: config.CUSTOM_DOMAIN_HTTPS_ENTRYPOINT,
      })
    : undefined;
  const worker = new ProvisioningWorker({ store, config, bench, health, domainIngress, logger: consoleLogger });

  const shutdown = (signal: string) => {
    consoleLogger.info({ signal }, 'stopping worker');
    worker.stop();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await worker.start();
  await disconnectPrisma();
}

main().catch((err) => {
  console.error('Fatal worker error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
