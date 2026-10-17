import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { getPrisma, disconnectPrisma } from '../db/prisma.js';
import { PrismaStore } from '../domain/prismaStore.js';
import { BackupService } from '../admin/backupService.js';
import type { User } from '../domain/types.js';

/**
 * Portable backup/restore for use in CI, cron or a fresh deployment:
 *
 *   pnpm backup:export ./platform-backup.json
 *   pnpm backup:import ./platform-backup.json --dry-run
 *   pnpm backup:import ./platform-backup.json --base-domain new.example.com
 *
 * Runs with full database credentials, so treat the backup file as sensitive:
 * it contains account emails and ownership, but never sessions or tokens.
 */
function cliActor(): User {
  const now = new Date();
  return {
    id: 'cli',
    oauthSubject: 'cli',
    email: 'cli@localhost',
    name: 'CLI',
    role: 'admin',
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function main(): Promise<void> {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!command || !file) {
    console.error('usage: backup <export|import> <file> [--dry-run] [--base-domain <domain>]');
    process.exit(1);
  }
  const dryRun = rest.includes('--dry-run');
  const baseDomainIdx = rest.indexOf('--base-domain');
  const baseDomainOverride = baseDomainIdx >= 0 ? (rest[baseDomainIdx + 1] ?? null) : null;

  const config = loadConfig();
  const store = new PrismaStore(getPrisma());
  const service = new BackupService(store, config);
  const actor = cliActor();

  try {
    if (command === 'export') {
      const snapshot = await service.exportState(actor);
      await writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8');
      console.log(
        `Exported ${snapshot.users.length} users, ${snapshot.instances.length} instances, ${snapshot.jobs.length} jobs to ${file}`,
      );
    } else if (command === 'import') {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const summary = await service.importState(actor, raw, { dryRun, baseDomainOverride });
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err) => {
  console.error('Backup command failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
