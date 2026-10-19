import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCustomDomain } from '../instances/validation.js';

export interface DomainIngress {
  configure(domain: string): Promise<void>;
  remove(domain: string): Promise<void>;
}

export interface TraefikFileIngressOptions {
  routesDir: string;
  upstreamUrl: string;
  certResolver: string;
  httpEntryPoint?: string;
  httpsEntryPoint?: string;
}

export class TraefikFileIngress implements DomainIngress {
  private readonly upstreamUrl: string;
  private readonly certResolver: string;
  private readonly httpEntryPoint: string;
  private readonly httpsEntryPoint: string;

  constructor(private readonly options: TraefikFileIngressOptions) {
    const upstream = new URL(options.upstreamUrl);
    if (
      !['http:', 'https:'].includes(upstream.protocol) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== '/' ||
      upstream.search ||
      upstream.hash
    ) {
      throw new Error('Custom-domain upstream must be an HTTP(S) URL without credentials');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(options.certResolver)) {
      throw new Error('Custom-domain certificate resolver name is invalid');
    }
    this.upstreamUrl = upstream.origin;
    this.certResolver = options.certResolver;
    this.httpEntryPoint = options.httpEntryPoint ?? 'web';
    this.httpsEntryPoint = options.httpsEntryPoint ?? 'websecure';
    for (const entryPoint of [this.httpEntryPoint, this.httpsEntryPoint]) {
      if (!/^[A-Za-z0-9_-]+$/.test(entryPoint)) {
        throw new Error('Custom-domain Traefik entry point name is invalid');
      }
    }
  }

  async configure(input: string): Promise<void> {
    const domain = this.normalize(input);
    await mkdir(this.options.routesDir, { recursive: true });
    const destination = this.routePath(domain);
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, this.routeConfig(domain), { encoding: 'utf8', mode: 0o640, flag: 'wx' });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(input: string): Promise<void> {
    const domain = this.normalize(input);
    await rm(this.routePath(domain), { force: true });
  }

  private normalize(input: string): string {
    const domain = normalizeCustomDomain(input);
    if (domain !== input) throw new Error('Custom-domain ingress requires a normalized hostname');
    return domain;
  }

  private routePath(domain: string): string {
    const id = createHash('sha256').update(domain).digest('hex');
    return join(this.options.routesDir, `custom-domain-${id}.yml`);
  }

  private routeConfig(domain: string): string {
    const id = createHash('sha256').update(domain).digest('hex');
    const router = `custom-domain-${id}`;
    const service = `custom-domain-${id}`;
    const middleware = `custom-domain-${id}-https`;
    return [
      'http:',
      '  routers:',
      `    ${router}-https:`,
      `      rule: "Host(\`${domain}\`)"`,
      `      entryPoints: [${this.httpsEntryPoint}]`,
      `      service: ${service}`,
      `      tls:`,
      `        certResolver: ${this.certResolver}`,
      `    ${router}-http:`,
      `      rule: "Host(\`${domain}\`)"`,
      `      entryPoints: [${this.httpEntryPoint}]`,
      `      middlewares: [${middleware}]`,
      `      service: ${service}`,
      '  middlewares:',
      `    ${middleware}:`,
      '      redirectScheme:',
      '        scheme: https',
      '        permanent: true',
      '  services:',
      `    ${service}:`,
      '      loadBalancer:',
      `        servers: [{ url: ${JSON.stringify(this.upstreamUrl)} }]`,
      '',
    ].join('\n');
  }
}
