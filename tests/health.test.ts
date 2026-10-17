import { describe, expect, it, vi } from 'vitest';
import { waitForHealthy } from '../src/provisioning/health.js';

describe('site health checks', () => {
  it('checks the configured internal ingress while routing by the tenant Host header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'pong' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await waitForHealthy('acme.apps.example.test', {
      baseUrl: 'http://frappe-frontend:8080',
      timeoutMs: 1000,
      intervalMs: 1,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://frappe-frontend:8080/api/method/ping',
      expect.objectContaining({
        headers: { host: 'acme.apps.example.test' },
        redirect: 'manual',
      }),
    );
  });
});
