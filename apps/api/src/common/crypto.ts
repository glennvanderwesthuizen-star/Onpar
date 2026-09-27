import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const hashSecret = (plain: string) => hash(plain);
export const verifySecret = (hashed: string, plain: string) => verify(hashed, plain).catch(() => false);

/** A long random token for a device, shown once at registration. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Device tokens are high-entropy, so a fast hash is enough to store them. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A random numeric PIN of the given length. */
export function newPin(length = 6): string {
  let pin = '';
  for (let i = 0; i < length; i++) pin += randomInt(10).toString();
  return pin;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** Keyed hash, so duplicate ID numbers can be found without storing them in the clear. */
export function hmac(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex');
}
