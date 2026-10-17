import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

/** Lazily create a single PrismaClient per process. */
export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!client) {
    client = new PrismaClient(
      databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
    );
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
