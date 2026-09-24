import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { LanguageSwitch } from './Login';

export function AuthShell({ children, title }: { children: ReactNode; title?: string }) {
  const t = useT();
  return (
    <div className="screen">
      <div className="row-between" style={{ padding: '12px var(--gutter)' }}>
        <span />
        <LanguageSwitch />
      </div>
      <div className="screen-body" style={{ maxWidth: 440 }}>
        <div className="center stack" style={{ margin: '12px 0 8px' }}>
          <img src="/mark.svg" width={64} height={64} alt="" style={{ margin: '0 auto' }} />
          <h1>GetFlop <span style={{ color: 'var(--gold-2)', fontStyle: 'italic', fontWeight: 600 }}>Live</span></h1>
          <p className="muted">{title ?? t('slogan')}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
