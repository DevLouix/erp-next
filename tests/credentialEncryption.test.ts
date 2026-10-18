import { describe, expect, it } from 'vitest';
import { decryptCredential, encryptCredential } from '../src/admin/credentialEncryption.js';

const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('backup credential encryption', () => {
  it('encrypts credentials with randomized authenticated ciphertext', () => {
    const first = encryptCredential('s3-secret', key);
    const second = encryptCredential('s3-secret', key);

    expect(first).not.toContain('s3-secret');
    expect(second).not.toBe(first);
    expect(decryptCredential(first, key)).toBe('s3-secret');
  });

  it('rejects missing, malformed, or incorrect encryption keys', () => {
    expect(() => encryptCredential('secret', undefined)).toThrow(
      'BACKUP_CREDENTIALS_ENCRYPTION_KEY is required',
    );
    expect(() => encryptCredential('secret', 'short')).toThrow('base64-encoded 32-byte');
    const encrypted = encryptCredential('secret', key);
    expect(() => decryptCredential(encrypted, 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')).toThrow(
      'Could not decrypt stored credentials',
    );
  });
});
