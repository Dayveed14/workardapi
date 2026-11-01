// Encrypts secrets we must store (e.g. a business's Paystack secret key) with AES-256-GCM.
// The key comes from ENCRYPTION_KEY in .env — 64 hex characters. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// If ENCRYPTION_KEY is lost, stored secrets can't be read back (businesses re-enter them).
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import AppError from './AppError.js';

function getKey() {
  if (!/^[0-9a-f]{64}$/i.test(env.encryptionKey || '')) {
    throw new AppError(500, 'ENCRYPTION_KEY is missing or invalid in the server .env');
  }
  return Buffer.from(env.encryptionKey, 'hex');
}

// "secret" → "iv:tag:ciphertext" (all hex)
export function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
}

export function decrypt(stored) {
  const [iv, tag, data] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}
