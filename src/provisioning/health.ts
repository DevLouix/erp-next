export interface HealthCheckOptions {
  timeoutMs: number;
  intervalMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll the fresh site's Frappe ping endpoint until it answers `pong`.
 * A site is never marked ready until this succeeds.
 */
export async function waitForHealthy(
  hostname: string,
  options: HealthCheckOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  const url = new URL('/api/method/ping', options.baseUrl ?? `https://${hostname}`).toString();
  let lastError = 'no response';

  for (;;) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'manual',
        headers: { host: hostname },
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (body?.message === 'pong') return;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (now() >= deadline) {
      throw new Error(`Health check for ${hostname} did not pass in time (${lastError})`);
    }
    await sleep(options.intervalMs);
  }
}
