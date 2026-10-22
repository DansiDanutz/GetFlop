import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Sheet } from '../../components/Sheet';
import { useT } from '../../i18n/i18n';
import { MAX_ZOOM, renderCrop, type CropState } from './crop';

interface Props { file: File | null; onCancel: () => void; onDone: (dataUrl: string) => void; onError: (key: string) => void }

const START: CropState = { zoom: 1, x: 0, y: 0 };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Square crop with drag, pinch and a zoom slider (up to 4×); output ≤ 512 px JPEG ≤ 200 KB (08 §4). */
export function PhotoCropSheet({ file, onCancel, onDone, onError }: Props) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropState>(START);
  const img = useRef<HTMLImageElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);

  useEffect(() => {
    if (!file) { setSrc(null); return; }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { onError('err_club_logo_invalid'); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    setCrop(START);
    return () => URL.revokeObjectURL(url);
  }, [file, onError]);

  const el = img.current;
  const box = frame.current?.clientWidth ?? 300;
  const base = el ? box / Math.min(el.naturalWidth || 1, el.naturalHeight || 1) : 1;
  const w = el ? el.naturalWidth * base * crop.zoom : 0;
  const h = el ? el.naturalHeight * base * crop.zoom : 0;
  const freeX = Math.max(0, w - box) / 2;
  const freeY = Math.max(0, h - box) / 2;

  function onMove(e: PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      if (pinch.current) setCrop((c) => ({ ...c, zoom: clamp(c.zoom * (dist / pinch.current!), 1, MAX_ZOOM) }));
      pinch.current = dist;
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    setCrop((c) => ({ ...c, x: freeX ? clamp(c.x - dx / freeX, -1, 1) : 0, y: freeY ? clamp(c.y - dy / freeY, -1, 1) : 0 }));
  }
  const end = (e: PointerEvent) => { pointers.current.delete(e.pointerId); pinch.current = null; };

  function done() {
    if (!img.current) return;
    const out = renderCrop(img.current, crop);
    if (!out) { onError('err_club_logo_too_large'); return; }
    onDone(out);
  }

  return (
    <Sheet open={Boolean(file)} onClose={onCancel} title={t('own_photo_crop_title')} modal>
      <p className="muted">{t('own_photo_crop_hint')}</p>
      <div ref={frame} className="own-crop"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); }}
        onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
        {src && (
          <img ref={img} src={src} alt="" onLoad={() => setCrop({ ...START })}
            style={{ width: w || undefined, height: h || undefined, transform: `translate(calc(-50% - ${crop.x * freeX}px), calc(-50% - ${crop.y * freeY}px))` }} />
        )}
      </div>
      <label>{t('own_photo_zoom')}
        <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} onChange={(e) => setCrop((c) => ({ ...c, zoom: Number(e.target.value) }))} />
      </label>
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="btn primary" onClick={done} disabled={!src}>{t('own_photo_use')}</button>
      </div>
    </Sheet>
  );
}
