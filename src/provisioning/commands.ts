import { execFile } from 'node:child_process';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * The only way this process runs an external program. Arguments are always
 * passed as an array to execFile — never a shell string — so customer input
 * can never be interpreted as shell syntax.
 */
export interface CommandRunner {
  run(file: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

export class ExecFileRunner implements CommandRunner {
  async run(file: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs ?? 30 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
          shell: false,
        },
        (error, stdout, stderr) => {
          const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : error
                ? 1
                : 0;
          resolve({
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? '',
            code,
            timedOut,
          });
        },
      );
    });
  }
}

/** Replace any secret material before a string is logged or persisted. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** A command failed. `message` is already redacted and safe to surface. */
export class BenchCommandError extends Error {
  constructor(
    message: string,
    public readonly result: CommandResult,
  ) {
    super(message);
    this.name = 'BenchCommandError';
  }
}
