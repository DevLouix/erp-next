import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;

function parseKey(encodedKey: string | undefined): Buffer {
  if (!encodedKey) {
    throw new Error('BACKUP_CREDENTIALS_ENCRYPTION_KEY is required for encrypted credentials');
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
    throw new Error('BACKUP_CREDENTIALS_ENCRYPTION_KEY must be base64-encoded 32-byte key material');
  }
  return key;
}

export function encryptCredential(value: string, encodedKey: string | undefined): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, parseKey(encodedKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${nonce.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptCredential(value: string, encodedKey: string | undefined): string {
  const [version, nonceValue, tagValue, ciphertextValue, extra] = value.split(':');
  if (version !== 'v1' || !nonceValue || !tagValue || ciphertextValue === undefined || extra) {
    throw new Error('Stored credential ciphertext has an unsupported format');
  }
  const nonce = Buffer.from(nonceValue, 'base64');
  const tag = Buffer.from(tagValue, 'base64');
  const ciphertext = Buffer.from(ciphertextValue, 'base64');
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error('Stored credential ciphertext is invalid');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, parseKey(encodedKey), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt stored credentials; verify BACKUP_CREDENTIALS_ENCRYPTION_KEY');
  }
}
