import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../http/errors.js';

/** A code is shown for one 60-second window and accepted for a little over a minute. */
export const CODE_WINDOW_SECONDS = 60;
const MAX_AGE_SECONDS = 2 * CODE_WINDOW_SECONDS;
const CLOCK_SKEW_SECONDS = 30;
const SIG_LENGTH = 22;
const DEV_SECRET = 'getflop-dev-player-code-secret';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CODE_RE = new RegExp(`^(${UUID})\\.(\\d{9,11})\\.([A-Za-z0-9_-]{${SIG_LENGTH}})$`, 'i');
const OLD_RE = new RegExp(`(^|/inspector/player/)${UUID}$`, 'i');

/** HMAC key from PLAYER_CODE_SECRET. A development default is used outside production only. */
function secret(): string {
  const fromEnv = process.env.PLAYER_CODE_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') throw new Error('PLAYER_CODE_SECRET is not configured');
  return DEV_SECRET;
}

const sign = (payload: string): string => createHmac('sha256', secret()).update(payload).digest('base64url').slice(0, SIG_LENGTH);

const windowStart = (now: Date): number => Math.floor(now.getTime() / 1000 / CODE_WINDOW_SECONDS) * CODE_WINDOW_SECONDS;

/** `<userId>.<window start, unix seconds>.<signature>`; a new code every CODE_WINDOW_SECONDS. */
export function issuePlayerCode(userId: string, now: Date): string {
  const counter = windowStart(now);
  return `${userId}.${counter}.${sign(`${userId}.${counter}`)}`;
}

export function secondsUntilRotation(now: Date): number {
  return windowStart(now) + CODE_WINDOW_SECONDS - Math.floor(now.getTime() / 1000);
}

/** Accepts the bare code or a `…#/pc/<code>` link. */
export function extractCode(text: string): string {
  const trimmed = text.trim();
  const at = trimmed.lastIndexOf('/pc/');
  const raw = at >= 0 ? trimmed.slice(at + 4) : trimmed;
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw;
  }
}

/** Returns the user id of a valid, fresh player code; throws club.scan_code_* otherwise. */
export function verifyPlayerCode(text: string, now: Date): string {
  const code = extractCode(text);
  if (OLD_RE.test(code)) throw new AppError('club.scan_code_old');
  const match = CODE_RE.exec(code);
  if (!match) throw new AppError('club.scan_code_invalid');
  const [, userId, counterText, sig] = match as unknown as [string, string, string, string];
  const expected = Buffer.from(sign(`${userId}.${counterText}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AppError('club.scan_code_invalid');
  const age = Math.floor(now.getTime() / 1000) - Number(counterText);
  if (age > MAX_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) throw new AppError('club.scan_code_expired', 410);
  return userId.toLowerCase();
}
