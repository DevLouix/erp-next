export interface HealthCheckOptions {
  timeoutMs: number;
  intervalMs: number;
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
  const url = `https://${hostname}/api/method/ping`;
  let lastError = 'no response';

  for (;;) {
    try {
      const res = await fetchImpl(url, { redirect: 'manual' });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (body?.message === 'pong' || body?.message === 'pong') return;
        if (body?.message) return;
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
