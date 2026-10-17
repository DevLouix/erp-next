import type { CommandRunner, CommandResult } from './commands.js';
import { BenchCommandError, redact } from './commands.js';

export interface BenchConfig {
  benchBin: string;
  benchPath: string;
  mariadbRootPassword: string;
  erpnextAdminPassword: string;
  mariadbHost?: string;
  erpnextApp: string;
}

/**
 * Thin wrapper around the supported `bench` CLI.
 *
 * Every method maps to a documented Frappe Bench command. No method accepts a
 * caller-provided flag or free-form argument: the only variable inputs are the
 * already-validated site name and hostname.
 */
export class BenchClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly config: BenchConfig,
  ) {}

  private get secrets(): string[] {
    return [this.config.mariadbRootPassword, this.config.erpnextAdminPassword];
  }

  private async bench(args: string[]): Promise<CommandResult> {
    const result = await this.runner.run(this.config.benchBin, args, {
      cwd: this.config.benchPath,
    });
    return {
      ...result,
      stdout: redact(result.stdout, this.secrets),
      stderr: redact(result.stderr, this.secrets),
    };
  }

  private assertOk(result: CommandResult, description: string): void {
    if (result.code !== 0) {
      const detail = redact((result.stderr || result.stdout).trim(), this.secrets).slice(0, 500);
      throw new BenchCommandError(
        `${description} failed${detail ? `: ${detail}` : ''}`,
        result,
      );
    }
  }

  /** `bench new-site` — creates the site directory and its MariaDB database. */
  async newSite(siteName: string): Promise<CommandResult> {
    const args = [
      'new-site',
      siteName,
      '--admin-password',
      this.config.erpnextAdminPassword,
      '--mariadb-root-password',
      this.config.mariadbRootPassword,
      '--no-mariadb-socket',
    ];
    if (this.config.mariadbHost) args.push('--mariadb-host', this.config.mariadbHost);
    const result = await this.bench(args);
    this.assertOk(result, `Creating site ${siteName}`);
    return result;
  }

  /** `bench --site <site> list-apps` — returns installed app names. */
  async listApps(siteName: string): Promise<string[]> {
    const result = await this.bench(['--site', siteName, 'list-apps']);
    this.assertOk(result, `Listing apps for ${siteName}`);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0] ?? line);
  }

  /** `bench --site <site> install-app <app>` */
  async installApp(siteName: string, app: string): Promise<CommandResult> {
    const result = await this.bench(['--site', siteName, 'install-app', app]);
    this.assertOk(result, `Installing ${app} on ${siteName}`);
    return result;
  }

  /** Ensure the ERPNext app is present on the site exactly once. */
  async ensureAppInstalled(siteName: string, app: string): Promise<void> {
    const apps = await this.listApps(siteName);
    if (apps.includes(app)) return;
    await this.installApp(siteName, app);
  }

  /** Persist the canonical hostname in the site config. */
  async setHostname(siteName: string, hostname: string): Promise<void> {
    const result = await this.bench([
      '--site',
      siteName,
      'set-config',
      'host_name',
      `https://${hostname}`,
    ]);
    this.assertOk(result, `Configuring hostname for ${siteName}`);
  }

  /** Regenerate and reload the nginx vhosts so the new hostname is routed. */
  async configureRouting(): Promise<void> {
    const setup = await this.bench(['setup', 'nginx']);
    this.assertOk(setup, 'Regenerating nginx configuration');
    const reload = await this.bench(['reload-nginx']);
    this.assertOk(reload, 'Reloading nginx');
  }

  /** Best-effort teardown of a partially provisioned site. */
  async dropSite(siteName: string): Promise<CommandResult> {
    return this.bench([
      'drop-site',
      siteName,
      '--force',
      '--no-backup',
      '--mariadb-root-password',
      this.config.mariadbRootPassword,
    ]);
  }
}
