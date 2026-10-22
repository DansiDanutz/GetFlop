import type { ScanResult } from './api';

export const SCAN_MAX_SIDE = 1568;
export const SCAN_JPEG_QUALITY = 0.85;

/** Downscaled size so the longest side is at most `max` (never upscales). */
export function scaledSize(width: number, height: number, max = SCAN_MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const f = max / longest;
  return { width: Math.round(width * f), height: Math.round(height * f) };
}

/** What to tell the dealer about a scan result (translation key + params). */
export function scanMessage(result: ScanResult): { key: string; params: Record<string, number> } {
  if (result.cards.length < 3) return { key: 'dealer_scan_partial', params: { n: result.cards.length } };
  return { key: result.confidence === 'high' ? 'dealer_scan_ok' : 'dealer_scan_doubt', params: {} };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image unreadable')); };
    img.src = url;
  });
}

/** Photo → downscaled JPEG as base64 (no data: prefix), ready for scan-flop. */
export async function photoToScanBase64(file: File): Promise<string> {
  const img = await loadImage(file);
  const { width, height } = scaledSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas unavailable');
  g.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', SCAN_JPEG_QUALITY);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
