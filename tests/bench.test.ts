import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchClient } from '../src/provisioning/bench.js';
import { ExecFileRunner, redact, type CommandResult, type CommandRunner, type RunOptions } from '../src/provisioning/commands.js';

const SECRETS = { root: 'root-secret-pw', admin: 'admin-secret-pw' };

interface Call {
  file: string;
  args: string[];
  options?: RunOptions;
}

class RecordingRunner implements CommandRunner {
  calls: Call[] = [];
  responses: CommandResult[] = [];

  async run(file: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ file, args, options });
    return this.responses.shift() ?? { stdout: '', stderr: '', code: 0, timedOut: false };
  }
}

function makeClient(mariadbHost?: string): { client: BenchClient; runner: RecordingRunner } {
  const runner = new RecordingRunner();
  const client = new BenchClient(runner, {
    benchBin: 'bench',
    benchPath: '/home/frappe/frappe-bench',
    mariadbRootPassword: SECRETS.root,
    erpnextAdminPassword: SECRETS.admin,
    mariadbHost,
    erpnextApp: 'erpnext',
  });
  return { client, runner };
}

describe('BenchClient command construction', () => {
  it('builds bench new-site with safe, array-form arguments', async () => {
    const { client, runner } = makeClient();
    await client.newSite('acme.apps.example.test');
    expect(runner.calls[0]?.file).toBe('bench');
    expect(runner.calls[0]?.args).toEqual([
      'new-site',
      'acme.apps.example.test',
      '--admin-password',
      SECRETS.admin,
      '--mariadb-root-password',
      SECRETS.root,
      '--no-mariadb-socket',
    ]);
    expect(runner.calls[0]?.options?.cwd).toBe('/home/frappe/frappe-bench');
  });

  it('uses the supported db-host option when MariaDB host is configured', async () => {
    const { client, runner } = makeClient('frappe-db');
    await client.newSite('acme.apps.example.test');
    expect(runner.calls[0]?.args).toContain('--db-host');
    expect(runner.calls[0]?.args).toContain('frappe-db');
    expect(runner.calls[0]?.args).not.toContain('--mariadb-host');
  });

  it('adds and removes custom domains using Bench domain commands', async () => {
    const { client, runner } = makeClient();
    await client.addDomain('acme.apps.example.test', 'erp.acme.com');
    expect(runner.calls[0]?.args).toEqual([
      'setup',
      'add-domain',
      'erp.acme.com',
      '--site',
      'acme.apps.example.test',
    ]);
    await client.removeDomain('acme.apps.example.test', 'erp.acme.com');
    expect(runner.calls[1]?.args).toEqual([
      'setup',
      'remove-domain',
      'erp.acme.com',
      '--site',
      'acme.apps.example.test',
    ]);
  });

  it('uses the supplied per-site Administrator password and redacts it from command errors', async () => {
    const { client, runner } = makeClient();
    runner.responses.push({
      stdout: '',
      stderr: 'Failed while applying customer-specific-password',
      code: 1,
      timedOut: false,
    });
    await expect(
      client.newSite('acme.apps.example.test', 'customer-specific-password'),
    ).rejects.toThrow('[REDACTED]');
    expect(runner.calls[0]?.args).toContain('customer-specific-password');

    await client.newSite('acme.apps.example.test', 'customer-specific-password');
    expect(runner.calls[1]?.args).toContain('customer-specific-password');

    runner.responses.push({
      stdout: '',
      stderr: 'Failed while applying customer-specific-password',
      code: 1,
      timedOut: false,
    });
    await expect(
      client.setAdminPassword('acme.apps.example.test', 'customer-specific-password'),
    ).rejects.toThrow('[REDACTED]');
    expect(runner.calls[2]?.args).toEqual([
      '--site',
      'acme.apps.example.test',
      'set-admin-password',
      'customer-specific-password',
    ]);
  });

  it('creates and archives complete Bench database and file backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erpnext-backup-test-'));
    const site = 'acme.apps.example.test';
    const source = join(root, 'sites', site, 'private', 'backups');
    const archive = join(root, 'archive');
    const runner = new RecordingRunner();
    runner.run = async (file, args, options) => {
      runner.calls.push({ file, args, options });
      await mkdir(source, { recursive: true });
      await Promise.all([
        writeFile(join(source, '2026-10-17-database.sql.gz'), 'database'),
        writeFile(join(source, '2026-10-17-files.tar'), 'public'),
        writeFile(join(source, '2026-10-17-private-files.tar'), 'private'),
        writeFile(join(source, '2026-10-17-site_config_backup.json'), '{}'),
      ]);
      return { stdout: 'Backup complete', stderr: '', code: 0, timedOut: false };
    };
    const client = new BenchClient(runner, {
      benchBin: 'bench',
      benchPath: root,
      backupPath: archive,
      mariadbRootPassword: SECRETS.root,
      erpnextAdminPassword: SECRETS.admin,
      erpnextApp: 'erpnext',
    });
    try {
      const parts = await client.backupSite(site);
      expect(parts.map((part) => part.kind).sort()).toEqual([
        'database',
        'private-files',
        'public-files',
        'site-config',
      ]);
      expect(await readFile(join(archive, parts[0]!.relativePath), 'utf8')).toBeTruthy();
      expect(runner.calls[0]?.args).toEqual(['--site', site, 'backup', '--with-files']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recognizes Frappe archives encrypted with the site backup key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erpnext-backup-test-'));
    const site = 'acme.apps.example.test';
    const source = join(root, 'sites', site, 'private', 'backups');
    const runner = new RecordingRunner();
    runner.run = async (file, args, options) => {
      runner.calls.push({ file, args, options });
      await mkdir(source, { recursive: true });
      await Promise.all([
        writeFile(join(source, '2026-10-17-database-enc.sql.gz'), 'database'),
        writeFile(join(source, '2026-10-17-files-enc.tar'), 'public'),
        writeFile(join(source, '2026-10-17-private-files-enc.tar'), 'private'),
        writeFile(join(source, '2026-10-17-site_config_backup-enc.json'), '{}'),
      ]);
      return { stdout: 'Backup complete', stderr: '', code: 0, timedOut: false };
    };
    const client = new BenchClient(runner, {
      benchBin: 'bench',
      benchPath: root,
      mariadbRootPassword: SECRETS.root,
      erpnextAdminPassword: SECRETS.admin,
      erpnextApp: 'erpnext',
    });
    try {
      const parts = await client.backupSite(site);
      expect(parts.map((part) => part.kind).sort()).toEqual([
        'database',
        'private-files',
        'public-files',
        'site-config',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a successful Bench command when the private-files archive is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'erpnext-backup-test-'));
    const site = 'acme.apps.example.test';
    const source = join(root, 'sites', site, 'private', 'backups');
    const runner = new RecordingRunner();
    runner.run = async (file, args, options) => {
      runner.calls.push({ file, args, options });
      await mkdir(source, { recursive: true });
      await Promise.all([
        writeFile(join(source, '2026-10-17-database.sql.gz'), 'database'),
        writeFile(join(source, '2026-10-17-files.tar'), 'public'),
      ]);
      return { stdout: 'Backup complete', stderr: '', code: 0, timedOut: false };
    };
    const client = new BenchClient(runner, {
      benchBin: 'bench',
      benchPath: root,
      mariadbRootPassword: SECRETS.root,
      erpnextAdminPassword: SECRETS.admin,
      erpnextApp: 'erpnext',
    });
    try {
      await expect(client.backupSite(site)).rejects.toThrow('private-files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs an app when it is missing', async () => {
    const { client, runner } = makeClient();
    runner.responses.push({ stdout: 'frappe\n', stderr: '', code: 0, timedOut: false });
    runner.responses.push({ stdout: 'installing erpnext\n', stderr: '', code: 0, timedOut: false });
    await client.ensureAppInstalled('site.test', 'erpnext');
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['--site', 'site.test', 'list-apps'],
      ['--site', 'site.test', 'install-app', 'erpnext'],
    ]);
  });

  it('skips installation when erpnext is already present', async () => {
    const { client, runner } = makeClient();
    runner.responses.push({ stdout: 'frappe\nerpnext\n', stderr: '', code: 0, timedOut: false });
    await client.ensureAppInstalled('site.test', 'erpnext');
    expect(runner.calls).toHaveLength(1);
  });

  it('sets the canonical hostname', async () => {
    const { client, runner } = makeClient();
    await client.setHostname('site.test', 'acme.example.test');
    expect(runner.calls[0]?.args).toEqual([
      '--site',
      'site.test',
      'set-config',
      'host_name',
      'https://acme.example.test',
    ]);
  });

  it('does not call the removed reload-nginx Bench command', async () => {
    const { client, runner } = makeClient();
    await client.configureRouting();
    expect(runner.calls.map((call) => call.args)).toEqual([['setup', 'nginx']]);
  });

  it('redacts credentials from failure messages', async () => {
    const { client, runner } = makeClient();
    runner.responses.push({
      stdout: '',
      stderr: `Access denied using password ${SECRETS.root}`,
      code: 1,
      timedOut: false,
    });
    const err = (await client.newSite('site.test').catch((e) => e)) as Error;
    expect(err.message).toContain('[REDACTED]');
    expect(err.message).not.toContain(SECRETS.root);
  });

  it('does not interpret shell metacharacters in site names', async () => {
    const { client, runner } = makeClient();
    // A malicious value would only reach here if validation were bypassed; the
    // client must still pass it as one argument, never through a shell.
    const malicious = 'acme; rm -rf /';
    await client.newSite(malicious);
    const args = runner.calls[0]?.args ?? [];
    expect(args).toContain(malicious);
    expect(args.filter((a) => a === malicious)).toHaveLength(1);
  });
});

describe('ExecFileRunner', () => {
  it('never spawns a shell (arguments are literal)', async () => {
    const runner = new ExecFileRunner();
    const literal = '$(echo pwned); `id`';
    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      literal,
    ]);
    expect(result.stdout).toBe(literal);
    expect(result.code).toBe(0);
  });
});

describe('redact', () => {
  it('replaces every secret occurrence', () => {
    expect(redact('a root-secret-pw b root-secret-pw', [SECRETS.root])).toBe(
      'a [REDACTED] b [REDACTED]',
    );
  });
});
