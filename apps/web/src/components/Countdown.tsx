import { useEffect, useState } from 'react';

interface CountdownRingProps {
  /** When the countdown ends. */
  endsAt: string | Date | null | undefined;
  totalSeconds: number;
  urgentAt?: number;
}

export function secondsLeft(endsAt: string | Date, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000));
}

export function CountdownRing({ endsAt, totalSeconds, urgentAt = 5 }: CountdownRingProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (!endsAt) return null;
  const left = secondsLeft(endsAt, now);
  const fraction = totalSeconds > 0 ? left / totalSeconds : 0;
  const r = 54;
  const c = 2 * Math.PI * r;
  return (
    <div className={`ring ${left <= urgentAt ? 'urgent' : ''}`} role="timer" aria-live="off" aria-label={`${left} seconds`}>
      <svg viewBox="0 0 120 120" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="5" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={left <= urgentAt ? 'var(--red)' : 'var(--gold)'} strokeWidth="5"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} style={{ transition: 'stroke-dashoffset 0.25s linear' }} />
      </svg>
      <span className="value">{left}</span>
    </div>
  );
}
