/** Downscales a picked photo to a JPEG data URL under a byte budget (lobby card photos). */

const MAX_SIDE = 512;
const QUALITIES = [0.82, 0.72];
const MAX_SHRINKS = 5;
export const PHOTO_BUDGET_BYTES = 200 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export const isAcceptedImage = (type: string): boolean => ACCEPTED.includes(type);

/** Approximate decoded size of a base64 data URL. */
export const dataUrlBytes = (url: string): number => Math.floor(((url.split(',')[1] ?? '').length * 3) / 4);

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_unreadable')); };
    img.src = url;
  });
}

export async function compressPhoto(file: File): Promise<string> {
  if (!isAcceptedImage(file.type)) throw new Error('image_type');
  const img = await loadImage(file);
  let side = MAX_SIDE;
  for (let attempt = 0; attempt < MAX_SHRINKS; attempt += 1) {
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const g = canvas.getContext('2d');
    if (!g) throw new Error('image_canvas');
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of QUALITIES) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (dataUrlBytes(url) <= PHOTO_BUDGET_BYTES) return url;
    }
    side = Math.round(side * 0.8);
  }
  throw new Error('image_too_large');
}
