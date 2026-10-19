import { describe, expect, it } from 'vitest';
import { buildHostname, deriveSiteNaming, normalizeCustomDomain, slugify } from '../src/instances/validation.js';
import { ValidationError } from '../src/domain/errors.js';

describe('slugify', () => {
  it('produces strict DNS labels', () => {
    expect(slugify('Acme Manufacturing Ltd.')).toBe('acme-manufacturing-ltd');
    expect(slugify('  Weird__Name!! ')).toBe('weird-name');
    expect(slugify('Café São Paulo')).toBe('cafe-sao-paulo');
  });

  it('never emits shell metacharacters', () => {
    const result = slugify('a; rm -rf / && $(whoami)');
    expect(result).toMatch(/^[a-z0-9-]*$/);
    expect(result).not.toContain(';');
    expect(result).not.toContain('$');
  });
});

describe('deriveSiteNaming', () => {
  it('derives site name and hostname from a company name', () => {
    const naming = deriveSiteNaming('Acme Manufacturing', 'apps.example.com');
    expect(naming.slug).toBe('acme-manufacturing');
    expect(naming.hostname).toBe('acme-manufacturing.apps.example.com');
    expect(naming.siteName).toBe(naming.hostname);
  });

  it('rejects empty, too-short and reserved names', () => {
    expect(() => deriveSiteNaming('', 'apps.example.com')).toThrow(ValidationError);
    expect(() => deriveSiteNaming('ab', 'apps.example.com')).toThrow(ValidationError);
    expect(() => deriveSiteNaming('www', 'apps.example.com')).toThrow(ValidationError);
    expect(() => deriveSiteNaming('admin', 'apps.example.com')).toThrow(ValidationError);
  });

  it('does not allow path traversal or dots in the label', () => {
    const naming = deriveSiteNaming('../../etc/passwd', 'apps.example.com');
    expect(naming.hostname).toBe('etc-passwd.apps.example.com');
  });
});

describe('buildHostname', () => {
  it('rejects an empty base domain', () => {
    expect(() => buildHostname('acme', '')).toThrow(ValidationError);
  });

  describe('normalizeCustomDomain', () => {
    it('normalizes case and internationalized hostnames to DNS form', () => {
      expect(normalizeCustomDomain(' ERP.Example.COM. ')).toBe('erp.example.com');
      expect(normalizeCustomDomain('café.example.com')).toBe('xn--caf-dma.example.com');
    });

    it('rejects URLs, wildcards, IP addresses, local names, and malformed labels', () => {
      for (const value of [
        'https://erp.example.com',
        '*.example.com',
        '127.0.0.1',
        'erp.localhost',
        'bad..example.com',
        '-bad.example.com',
      ]) {
        expect(() => normalizeCustomDomain(value)).toThrow(ValidationError);
      }
    });
  });
});
