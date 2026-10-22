import { deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

/** A4 in PDF points. */
const A4_PT = { width: 595.28, height: 841.89 } as const;

export interface Raster { readonly width: number; readonly height: number; readonly png: Buffer; readonly rgba: Buffer }

/** Rasterizes SVG with the system fonts (no network, no paid service). */
export function rasterize(svg: string): Raster {
  const image = new Resvg(svg, {
    fitTo: { mode: 'original' },
    background: '#ffffff',
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  }).render();
  return { width: image.width, height: image.height, png: Buffer.from(image.asPng()), rgba: Buffer.from(image.pixels) };
}

function rgbaToRgb(rgba: Buffer): Buffer {
  const pixels = rgba.length / 4;
  const rgb = Buffer.allocUnsafe(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = rgba[i * 4]!;
    rgb[i * 3 + 1] = rgba[i * 4 + 1]!;
    rgb[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return rgb;
}

/** A one-page A4 PDF holding the raster as a full-page Flate-compressed RGB image. */
export function pdfFromRaster(raster: Raster, title = 'Poster'): Buffer {
  const image = deflateSync(rgbaToRgb(raster.rgba));
  const content = Buffer.from(`q ${A4_PT.width} 0 0 ${A4_PT.height} 0 0 cm /Im0 Do Q`, 'latin1');
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PT.width} ${A4_PT.height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`, 'latin1'),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`, 'latin1'),
      image, Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]),
    Buffer.from(`<< /Title (${safeTitle}) /Producer (GetFlop) >>`, 'latin1'),
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = [
    'xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer', `<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>`, 'startxref', String(length), '%%EOF',
  ].join('\n');
  chunks.push(Buffer.from(`${xref}\n`, 'latin1'));
  return Buffer.concat(chunks);
}
