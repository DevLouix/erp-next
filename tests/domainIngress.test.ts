import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraefikFileIngress } from '../src/provisioning/domainIngress.js';

const directories: string[] = [];

async function makeIngress(): Promise<TraefikFileIngress> {
  const routesDir = await mkdtemp(join(tmpdir(), 'erpnext-domain-routes-'));
  directories.push(routesDir);
  return new TraefikFileIngress({
    routesDir,
    upstreamUrl: 'http://frappe-frontend:8080',
    certResolver: 'letsencrypt',
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Traefik file ingress', () => {
  it('writes an exact-host HTTPS route to the fixed Frappe upstream', async () => {
    const ingress = await makeIngress();
    await ingress.configure('erp.acme.com');
    const routesDir = directories[0]!;
    const files = await readdir(routesDir);
    expect(files).toHaveLength(1);
    const contents = await readFile(join(routesDir, files[0]!), 'utf8');

    expect(contents).toContain('Host(`erp.acme.com`)');
    expect(contents).toContain('certResolver: letsencrypt');
    expect(contents).toContain('redirectScheme:');
    expect(contents).toContain('http://frappe-frontend:8080');
    expect(contents).not.toContain('HostRegexp');
    expect((await stat(join(routesDir, files[0]!))).mode & 0o777).toBe(0o640);
  });

  it('updates an existing route atomically and removes only that hostname', async () => {
    const ingress = await makeIngress();
    await ingress.configure('erp.acme.com');
    await ingress.configure('erp.acme.com');
    expect(await readdir(directories[0]!)).toHaveLength(1);

    await ingress.remove('erp.acme.com');
    expect(await readdir(directories[0]!)).toHaveLength(0);
  });

  it('rejects non-normalized hostnames and unsafe ingress configuration', async () => {
    const ingress = await makeIngress();
    await expect(ingress.configure('https://erp.acme.com')).rejects.toThrow();
    await expect(ingress.configure('erp.acme.com\nrule: HostRegexp(`{any:.+}`)')).rejects.toThrow();
    expect(() => new TraefikFileIngress({
      routesDir: directories[0]!,
      upstreamUrl: 'file:///etc/passwd',
      certResolver: 'letsencrypt',
    })).toThrow('HTTP(S) URL');
    expect(() => new TraefikFileIngress({
      routesDir: directories[0]!,
      upstreamUrl: 'http://frappe-frontend:8080',
      certResolver: 'letsencrypt\nrouters:',
    })).toThrow('resolver name is invalid');
  });
});
