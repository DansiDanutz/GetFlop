import { AppError } from '../../http/errors.js';
import { PHOTO_MAX_BYTES, PHOTO_MAX_KB, PHOTO_MIMES } from './constants.js';

export interface Photo {
  readonly mime: (typeof PHOTO_MIMES)[number];
  readonly base64: string;
}

const DATA_URL = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/;

function magicMatches(mime: Photo['mime'], bytes: Buffer): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Parses a data URL photo and re-validates its type (by content) and size. */
export function parsePhoto(value: string): Photo {
  const match = DATA_URL.exec(value.trim());
  if (!match) throw new AppError('messages.photo_invalid', 400);
  const mime = match[1] as Photo['mime'];
  if (!PHOTO_MIMES.includes(mime)) throw new AppError('messages.photo_invalid', 400);
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > PHOTO_MAX_BYTES) throw new AppError('messages.photo_too_large', 400, { maxKb: PHOTO_MAX_KB });
  if (bytes.length < 12 || !magicMatches(mime, bytes)) throw new AppError('messages.photo_invalid', 400);
  return { mime, base64: bytes.toString('base64') };
}

export const photoDataUrl = (mime: string, base64: string): string => `data:${mime};base64,${base64}`;
