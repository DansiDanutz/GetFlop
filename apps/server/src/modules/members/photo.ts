import { AppError } from '../../http/errors.js';

/** Club photo cap after client-side compression (target ≤ 200 KB), with some headroom. */
export const LOGO_MAX_BYTES = 256 * 1024;

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

/**
 * Validates an uploaded club photo given as a data URL: JPEG, PNG or WebP (checked against the
 * file's own signature, not only the declared type) and at most LOGO_MAX_BYTES.
 */
export function assertLogo(value: string, maxBytes = LOGO_MAX_BYTES): string {
  const match = DATA_URL_RE.exec(value);
  if (!match) throw new AppError('club.logo_invalid');
  const [, type, base64] = match as unknown as [string, string, string];
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) throw new AppError('club.logo_too_large', 413, { maxKb: Math.round(maxBytes / 1024) });
  if (!MAGIC[type]?.(bytes)) throw new AppError('club.logo_invalid');
  return value;
}
