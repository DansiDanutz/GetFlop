import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 32;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, saltText, keyText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await scrypt(secret, Buffer.from(saltText, 'base64url'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const newToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** Numeric one-time code, e.g. for email verification and PIN reset. */
export const numericCode = (digits = 6): string =>
  Array.from(randomBytes(digits), (b) => String(b % 10)).join('');
