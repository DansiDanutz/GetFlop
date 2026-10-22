import QRCode from 'qrcode';
import type { PosterLabels } from './labels.js';

/** A4 at 300 dpi. */
export const A4_WIDTH_PX = 2480;
export const A4_HEIGHT_PX = 3508;

const FONT = "Arial, Helvetica, 'DejaVu Sans', sans-serif";
const INK = '#10231b';
const FELT = '#0d4a35';
const GOLD = '#e0b150';
const MARGIN = 180;
/** Average glyph width as a share of the font size, for line wrapping. */
const GLYPH_WIDTH = 0.52;

export type PosterInput =
  | { readonly kind: 'welcome'; readonly firstLine: string; readonly message: string; readonly extraLine?: string }
  | { readonly kind: 'tournament'; readonly name: string; readonly when: string; readonly secondLine?: string };

export interface PosterClub { readonly name: string; readonly publicId: string; readonly inviteUrl: string }

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Greedy word wrap by estimated width; very long words are split. */
export function wrap(text: string, fontSize: number, width: number): string[] {
  const maxChars = Math.max(4, Math.floor(width / (fontSize * GLYPH_WIDTH)));
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const pieces = word.match(new RegExp(`.{1,${maxChars}}`, 'gu')) ?? [word];
      for (const piece of pieces) {
        const next = line ? `${line} ${piece}` : piece;
        if (next.length > maxChars && line) { lines.push(line); line = piece; } else line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

interface Block { readonly text: string; readonly size: number; readonly weight?: number; readonly color?: string; readonly gap?: number }

/** Centered text blocks from `top`; returns the SVG and the y after the last line. */
function textBlocks(blocks: readonly Block[], top: number): { svg: string; bottom: number } {
  let y = top;
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    for (const line of wrap(b.text, b.size, A4_WIDTH_PX - 2 * MARGIN)) {
      y += b.size * 1.18;
      parts.push(`<text x="${A4_WIDTH_PX / 2}" y="${Math.round(y)}" text-anchor="middle" font-family="${FONT}" font-size="${b.size}" font-weight="${b.weight ?? 400}" fill="${b.color ?? INK}">${escapeXml(line)}</text>`);
    }
    y += b.gap ?? 40;
  }
  return { svg: parts.join(''), bottom: y };
}

/** The QR code as one vector path (dark modules), with a white quiet zone. */
export function qrSvg(text: string, x: number, y: number, size: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const cell = size / (n + 2 * quiet);
  const d: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) d.push(`M${((c + quiet) * cell).toFixed(2)} ${((r + quiet) * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`);
    }
  }
  return `<g transform="translate(${x} ${y})"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d.join('')}" fill="#000"/></g>`;
}

function headline(input: PosterInput, labels: PosterLabels): Block[] {
  if (input.kind === 'welcome') {
    return [
      { text: input.firstLine, size: 170, weight: 800, color: '#ffffff', gap: 50 },
      { text: input.message, size: 90, color: '#e8f1ec', gap: 30 },
    ];
  }
  return [
    { text: labels.tournament.toUpperCase(), size: 70, weight: 700, color: GOLD, gap: 30 },
    { text: input.name, size: 170, weight: 800, color: '#ffffff', gap: 50 },
    { text: input.when, size: 110, weight: 700, color: GOLD, gap: 30 },
  ];
}

/** The full A4 poster as SVG (the single source for preview, PNG and PDF). */
export function posterSvg(input: PosterInput, club: PosterClub, labels: PosterLabels): string {
  const clubName = textBlocks([{ text: club.name, size: 110, weight: 800, color: GOLD, gap: 90 }], MARGIN - 60);
  const head = textBlocks(headline(input, labels), clubName.bottom);
  const bandBottom = Math.max(1250, head.bottom + 60);
  const extra = input.kind === 'welcome' ? input.extraLine ?? '' : input.secondLine ?? '';
  const extraBlock = textBlocks([{ text: extra, size: 90, weight: 700, gap: 20 }], bandBottom + 40);
  const qrSize = 1300;
  const qrTop = Math.min(extraBlock.bottom + 40, A4_HEIGHT_PX - qrSize - 620);
  const footer = textBlocks([
    { text: labels.scanToJoin, size: 80, weight: 700, gap: 24 },
    { text: `${labels.clubId} ${club.publicId}`, size: 70, color: '#4b5d55', gap: 10 },
  ], qrTop + qrSize + 30);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${A4_WIDTH_PX}" height="${A4_HEIGHT_PX}" viewBox="0 0 ${A4_WIDTH_PX} ${A4_HEIGHT_PX}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<rect width="${A4_WIDTH_PX}" height="${bandBottom}" fill="${FELT}"/>`,
    `<rect y="${bandBottom}" width="${A4_WIDTH_PX}" height="16" fill="${GOLD}"/>`,
    clubName.svg, head.svg, extraBlock.svg,
    qrSvg(club.inviteUrl, (A4_WIDTH_PX - qrSize) / 2, qrTop, qrSize),
    footer.svg,
    `<text x="${A4_WIDTH_PX / 2}" y="${A4_HEIGHT_PX - 90}" text-anchor="middle" font-family="${FONT}" font-size="46" fill="#8a9a92">GetFlop</text>`,
    '</svg>',
  ].join('');
}
