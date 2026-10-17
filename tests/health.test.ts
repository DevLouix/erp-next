import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { waitForHealthy } from '../src/provisioning/health.js';

describe('site health checks', () => {
  it('checks the internal ingress with an actual tenant Host header', async () => {
    let receivedHost: string | undefined;
    const server = createServer((request, response) => {
      receivedHost = request.headers.host;
      response.writeHead(receivedHost === 'acme.apps.example.test' ? 200 : 404, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ message: receivedHost === 'acme.apps.example.test' ? 'pong' : 'not found' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP port');

    try {
      await waitForHealthy('acme.apps.example.test', {
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 1000,
        intervalMs: 1,
      });
      expect(receivedHost).toBe('acme.apps.example.test');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('continues polling until the external endpoint returns pong', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not ready', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'pong' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    let currentTime = 0;

    await waitForHealthy('acme.apps.example.test', {
      timeoutMs: 1000,
      intervalMs: 1,
      fetchImpl,
      sleepImpl: async () => { currentTime += 1; },
      now: () => currentTime,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith('https://acme.apps.example.test/api/method/ping', {
      redirect: 'manual',
    });
  });
});
