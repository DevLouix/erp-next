import 'dotenv/config';
import { loadConfig } from './config.js';
import { getPrisma, disconnectPrisma } from './db/prisma.js';
import { PrismaStore } from './domain/prismaStore.js';
import { ExecFileRunner } from './provisioning/commands.js';
import { BenchClient } from './provisioning/bench.js';
import { waitForHealthy } from './provisioning/health.js';
import { ProvisioningWorker, type HealthWaiter } from './provisioning/worker.js';
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

  const worker = new ProvisioningWorker({ store, config, bench, health, logger: consoleLogger });

  const shutdown = async (signal: string) => {
    consoleLogger.info({ signal }, 'stopping worker');
    worker.stop();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await worker.start();
}

main().catch((err) => {
  console.error('Fatal worker error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
