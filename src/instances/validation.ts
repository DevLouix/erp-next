import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { ValidationError } from '../domain/errors.js';

/**
 * Strict, allow-list based validation for user input that eventually becomes a
 * hostname and a Frappe site name. Nothing here ever emits a shell argument:
 * the value is reduced to [a-z0-9-] labels joined by dots.
 */

const SLUG_MIN = 3;
const SLUG_MAX = 30;

/** Subdomains we must never hand to a customer, regardless of input. */
export const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'mail',
  'smtp',
  'imap',
  'ftp',
  'ns',
  'ns1',
  'ns2',
  'dns',
  'cdn',
  'static',
  'assets',
  'status',
  'dashboard',
  'support',
  'help',
  'docs',
  'blog',
  'shop',
  'store',
  'test',
  'staging',
  'dev',
  'localhost',
]);

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Reduce arbitrary display text to a safe DNS label. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export interface SiteNaming {
  slug: string;
  siteName: string;
  hostname: string;
}

/**
 * Validate a requested company/site name and derive the safe site identifier
 * and hostname. Throws ValidationError with a user-facing message.
 */
export function deriveSiteNaming(companyName: string, baseDomain: string): SiteNaming {
  if (typeof companyName !== 'string' || companyName.trim().length === 0) {
    throw new ValidationError('Company name is required', { name: 'Company name is required' });
  }
  if (companyName.length > 100) {
    throw new ValidationError('Company name is too long', { name: 'Maximum 100 characters' });
  }

  const slug = slugify(companyName);
  if (slug.length < SLUG_MIN) {
    throw new ValidationError('Company name must contain at least 3 letters or numbers', {
      name: `Derived identifier "${slug}" is too short (min ${SLUG_MIN} characters)`,
    });
  }
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('Company name produces an invalid identifier', {
      name: 'Use letters, numbers and single hyphens',
    });
  }
  if (RESERVED_SUBDOMAINS.has(slug)) {
    throw new ValidationError(`"${slug}" is a reserved name`, {
      name: `"${slug}" is reserved, choose another name`,
    });
  }

  const hostname = buildHostname(slug, baseDomain);
  return { slug, siteName: hostname, hostname };
}

export function buildHostname(slug: string, baseDomain: string): string {
  const base = baseDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!base) throw new ValidationError('Server base domain is not configured');
  const hostname = `${slug}.${base}`;
  if (hostname.length > 253) {
    throw new ValidationError('Generated hostname is too long', {
      name: 'Choose a shorter company name',
    });
  }

  for (const label of hostname.split('.')) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) || label.length > 63) {
      throw new ValidationError('Generated hostname is invalid', {
        name: 'Choose a different company name',
      });
    }
  }
  return hostname;
}

export function normalizeCustomDomain(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/, '');
  if (!value || value.includes('://') || value.includes('/') || value.includes(':') || value.includes('*')) {
    throw new ValidationError('Enter a hostname only, without a scheme, path, port, or wildcard');
  }
  const hostname = domainToASCII(value);
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.split('.').length < 2 ||
    isIP(hostname) !== 0 ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.example')
  ) {
    throw new ValidationError('Enter a valid public domain name');
  }
  for (const label of hostname.split('.')) {
    if (label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new ValidationError('Enter a valid public domain name');
    }
  }
  return hostname;
}
