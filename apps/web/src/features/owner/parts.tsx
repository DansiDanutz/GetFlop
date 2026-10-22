import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { sortRoles } from './permissions';

export function Avatar({ name, photo, large }: { name: string; photo?: string | null; large?: boolean }) {
  return (
    <span className={`own-avatar${large ? ' lg' : ''}`} aria-hidden>
      {photo ? <img src={photo} alt="" /> : (name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function RoleBadges({ roles, watch }: { roles: readonly string[]; watch?: boolean }) {
  const t = useT();
  return (
    <span className="own-roles">
      {roles.length === 0 && <span className="own-role">{t('role_player')}</span>}
      {sortRoles(roles).map((r) => <span key={r} className={`own-role ${r}`}>{t(`role_${r}`)}</span>)}
      {watch && <span className="own-role watch">{t('own_watch_only')}</span>}
    </span>
  );
}

interface SwitchProps { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="own-switch"
      disabled={disabled} onClick={() => onChange(!checked)} />
  );
}

export function ToggleRow({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="own-toggle">
      <div className="grow">
        <strong>{title}</strong>
        {note && <div className="own-note">{note}</div>}
      </div>
      {children}
    </div>
  );
}
