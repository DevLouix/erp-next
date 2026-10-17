import { describe, expect, it } from 'vitest';
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

function makeClient(): { client: BenchClient; runner: RecordingRunner } {
  const runner = new RecordingRunner();
  const client = new BenchClient(runner, {
    benchBin: 'bench',
    benchPath: '/home/frappe/frappe-bench',
    mariadbRootPassword: SECRETS.root,
    erpnextAdminPassword: SECRETS.admin,
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
