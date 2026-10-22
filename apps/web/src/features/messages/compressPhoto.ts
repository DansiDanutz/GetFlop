import { PHOTO_MAX_BYTES, dataUrlBytes } from './logic';

/** Client photo processing for messages (08 §4): ≤ 512 px, JPEG 0.82 then 0.72, shrinking up to 5 times. */
const MAX_SIDE = 512;
const QUALITIES = [0.82, 0.72] as const;
const MAX_SHRINKS = 5;
const SHRINK_FACTOR = 0.8;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface CompressedPhoto { readonly dataUrl: string; readonly bytes: number }

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo.unreadable')); };
    img.src = url;
  });
}

function encode(img: HTMLImageElement, side: number, quality: number): string {
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('photo.canvas_unavailable');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Returns the smallest acceptable JPEG; the last attempt is returned even if still too big (the UI blocks it). */
export async function compressPhoto(file: File): Promise<CompressedPhoto> {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) throw new Error('photo.type');
  const img = await loadImage(file);
  let side = MAX_SIDE;
  let last: CompressedPhoto | null = null;
  for (let attempt = 0; attempt <= MAX_SHRINKS; attempt++) {
    for (const quality of QUALITIES) {
      const dataUrl = encode(img, side, quality);
      last = { dataUrl, bytes: dataUrlBytes(dataUrl) };
      if (last.bytes <= PHOTO_MAX_BYTES) return last;
    }
    side = Math.round(side * SHRINK_FACTOR);
  }
  return last!;
}
