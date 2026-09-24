import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import QRCode from 'qrcode';

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div style={{ fontSize: 34 }}>{icon}</div>}
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function StatTile({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export interface Tab { to: string; icon: ReactNode; label: ReactNode; dot?: boolean }

export function TabBar({ tabs }: { tabs: readonly Tab[] }) {
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="ico" aria-hidden>{tab.icon}</span>
          <span>{tab.label}</span>
          {tab.dot && <span className="dot" />}
        </NavLink>
      ))}
    </nav>
  );
}

/** Renders text as a QR code image. */
export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { width: size, margin: 1, color: { dark: '#0b0f0d', light: '#ffffff' } })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => setSrc(''));
    return () => { alive = false; };
  }, [text, size]);
  return src ? <img src={src} width={size} height={size} alt="QR code" style={{ borderRadius: 12, background: '#fff' }} /> : <Spinner />;
}

/** Badge for a hand status. */
export function HandBadge({ status, label }: { status: string | null | undefined; label: string }) {
  const cls = status === 'betting_open' ? 'open' : status === 'betting_closed' ? 'closed' : status === 'settled' ? 'live' : '';
  return <span className={`badge ${cls}`}>{label}</span>;
}
