import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status: number, code: string, message?: string): never => {
  throw new AppError(status, code, message);
};

export const newId = (prefix: string) => `${prefix}_${randomBytes(10).toString('base64url')}`;
export const newSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(password, salt, 32).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  return safeEqual(scryptSync(password, salt, 32).toString('base64url'), key);
}

// The one signature scheme used in both directions (operator -> GetFlop, GetFlop -> operator wallet).
export const signPayload = (secret: string, timestamp: string, method: string, path: string, body: string) =>
  hmac(secret, `${timestamp}.${method.toUpperCase()}.${path}.${body}`);

// Input guards. They throw 400s with the field name so integrators can fix calls quickly.
export function int(v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    fail(400, 'BAD_INPUT', `${field} must be an integer between ${min} and ${max}`);
  return v as number;
}

export function str(v: unknown, field: string, maxLen = 200, minLen = 1): string {
  if (typeof v !== 'string' || v.length < minLen || v.length > maxLen)
    fail(400, 'BAD_INPUT', `${field} must be a string of ${minLen}-${maxLen} characters`);
  return v as string;
}

export function optStr(v: unknown, field: string, maxLen = 200): string | null {
  return v === undefined || v === null || v === '' ? null : str(v, field, maxLen);
}
