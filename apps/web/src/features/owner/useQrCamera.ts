import { useEffect, useRef, useState } from 'react';

interface DetectedCode { rawValue: string }
interface Detector { detect(source: HTMLVideoElement): Promise<DetectedCode[]> }
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const SCAN_EVERY_MS = 300;

export const cameraScanSupported = (): boolean =>
  typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

/** Reads QR codes from the rear camera with BarcodeDetector while `active`; calls onCode once per value. */
export function useQrCamera(active: boolean, onCode: (text: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef('');
  useEffect(() => {
    if (!active || !cameraScanSupported()) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        if (stopped) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
        timer = setInterval(() => {
          if (!video.current || video.current.readyState < 2) return;
          detector.detect(video.current).then((codes) => {
            const value = codes[0]?.rawValue;
            if (value && value !== last.current) { last.current = value; onCode(value); }
          }).catch(() => undefined);
        }, SCAN_EVERY_MS);
      })
      .catch(() => setError('own_scan_camera_denied'));
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [active, onCode]);
  return { video, error, reset: () => { last.current = ''; } };
}
