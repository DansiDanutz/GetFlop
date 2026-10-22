/** Square crop of a club photo: zoom 1–4×, pan x/y in −1…1 (centre = 0). */
export interface CropState { readonly zoom: number; readonly x: number; readonly y: number }
export interface SourceRect { readonly sx: number; readonly sy: number; readonly size: number }

export const MAX_ZOOM = 4;
export const OUTPUT_MAX_PX = 512;
export const LOGO_MAX_BYTES = 200 * 1024;
const QUALITIES = [0.82, 0.72] as const;
const MAX_SHRINKS = 5;
const SHRINK_FACTOR = 0.8;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The part of the image visible in the square frame. */
export function cropRect(image: { width: number; height: number }, crop: CropState): SourceRect {
  const zoom = clamp(crop.zoom, 1, MAX_ZOOM);
  const size = Math.min(image.width, image.height) / zoom;
  const freeX = image.width - size;
  const freeY = image.height - size;
  const sx = freeX / 2 + (clamp(crop.x, -1, 1) * freeX) / 2;
  const sy = freeY / 2 + (clamp(crop.y, -1, 1) * freeY) / 2;
  return { sx: Math.round(sx), sy: Math.round(sy), size: Math.round(size) };
}

/** Bytes of a base64 data URL. */
export const dataUrlBytes = (url: string): number => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);

/**
 * JPEG at quality 0.82, then 0.72, then shrinking up to 5 times, until the result fits.
 * `encode(scale, quality)` returns a data URL (or any string whose length stands for its size).
 */
export function pickEncoding(encode: (scale: number, quality: number) => string, maxBytes: number, size: (s: string) => number = (s) => s.length): string | null {
  let scale = 1;
  for (let shrink = 0; shrink <= MAX_SHRINKS; shrink++) {
    for (const quality of QUALITIES) {
      const out = encode(scale, quality);
      if (size(out) <= maxBytes) return out;
    }
    scale *= SHRINK_FACTOR;
  }
  return null;
}

/** Draws the crop to a canvas (≤ 512 px) and returns a JPEG data URL within LOGO_MAX_BYTES, or null. */
export function renderCrop(img: HTMLImageElement, crop: CropState, maxBytes = LOGO_MAX_BYTES): string | null {
  const rect = cropRect({ width: img.naturalWidth, height: img.naturalHeight }, crop);
  const base = Math.min(OUTPUT_MAX_PX, rect.size);
  return pickEncoding((scale, quality) => {
    const px = Math.max(16, Math.round(base * scale));
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const g = canvas.getContext('2d');
    if (!g) return '';
    g.drawImage(img, rect.sx, rect.sy, rect.size, rect.size, 0, 0, px, px);
    return canvas.toDataURL('image/jpeg', quality);
  }, maxBytes, dataUrlBytes);
}
