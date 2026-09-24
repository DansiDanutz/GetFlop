import { z } from 'zod';
import { AppError } from '../../http/errors.js';

const UNSAFE_CHARS = /[<>"'`\\\u0000-\u001f\u007f]/;

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;
export const PIN_RE = /^\d{4,8}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function assertUsername(value: string): string {
  if (!USERNAME_RE.test(value)) throw new AppError('user.username_invalid');
  return value;
}

export function assertPin(value: string): string {
  if (!PIN_RE.test(value)) throw new AppError('auth.pin_invalid');
  return value;
}

export function assertEmail(value: string | undefined): string {
  const email = value?.trim().toLowerCase() ?? '';
  if (!email) throw new AppError('auth.email_required');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError('auth.email_invalid');
  return email;
}

/** Display, club, room and tournament names: printable, no markup characters. */
export function assertName(value: string, opts: { min: number; max: number; code: string }): string {
  const name = value.trim();
  if (name.length < opts.min || name.length > opts.max) throw new AppError(opts.code);
  if (UNSAFE_CHARS.test(name)) throw new AppError('name.invalid_chars');
  return name;
}

export function assertDisplayName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (!name) throw new AppError('auth.display_name_required');
  if (name.length > 30) throw new AppError('auth.display_name_too_long');
  return assertName(name, { min: 1, max: 30, code: 'auth.display_name_too_long' });
}

export const langSchema = z.enum(['en', 'el']).optional();
