import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface HealthCheckOptions {
  timeoutMs: number;
  intervalMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function requestInternalPing(
  url: URL,
  hostname: string,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string }> {
  const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requestImpl(
      url,
      { headers: { host: hostname } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => {
          clearTimeout(timer);
          resolve({ statusCode: response.statusCode ?? 0, body });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new Error('Health check request timed out'));
    }, timeoutMs);
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

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
  const url = new URL('/api/method/ping', options.baseUrl ?? `https://${hostname}`);
  let lastError = 'no response';

  for (;;) {
    try {
      if (options.baseUrl) {
        const res = await requestInternalPing(
          url,
          hostname,
          Math.max(1, Math.min(options.requestTimeoutMs ?? 10_000, deadline - now())),
        );
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = JSON.parse(res.body) as { message?: string };
          if (body.message === 'pong') return;
          lastError = 'unexpected ping response';
        } else {
          lastError = `HTTP ${res.statusCode}`;
        }
      } else {
        const res = await fetchImpl(url.toString(), { redirect: 'manual' });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          if (body?.message === 'pong') return;
          lastError = 'unexpected ping response';
        } else {
          lastError = `HTTP ${res.status}`;
        }
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
