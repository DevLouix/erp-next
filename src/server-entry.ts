import 'dotenv/config';
import { loadConfig } from './config.js';
import { getPrisma, disconnectPrisma } from './db/prisma.js';
import { PrismaStore } from './domain/prismaStore.js';
import { TruemoiIdentityProvider } from './auth/identityProvider.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  const store = new PrismaStore(prisma);
  const identity = new TruemoiIdentityProvider(config);

  const { app } = await buildApp({ config, store, identity });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  app.log.info({ port: config.PORT }, 'platform API listening');
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
