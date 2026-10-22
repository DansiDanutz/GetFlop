import { useNavigate } from 'react-router-dom';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useLayoutMode, type LayoutMode } from './layout';

interface DealerMenuProps {
  onStandUp: () => void;
  onTableQr: () => void;
  onAppQr: () => void;
}

const LAYOUT_OPTIONS: readonly LayoutMode[] = ['auto', 'compact', 'full'];

/** Entries added to the top bar menu on the console. */
export function DealerMenu({ onStandUp, onTableQr, onAppQr }: DealerMenuProps) {
  const t = useT();
  const navigate = useNavigate();
  const { mode, setMode } = useLayoutMode();
  return (
    <div className="stack">
      <span className="eyebrow">{t('dealer_title')}</span>
      <button type="button" className="btn ghost block" onClick={() => navigate('/dealer')}>{t('dealer_menu_back')}</button>
      <button type="button" className="btn ghost block" onClick={onStandUp}>{t('dealer_menu_stand')}</button>
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onTableQr}>{t('dealer_menu_table_qr')}</button>
        <button type="button" className="btn ghost" onClick={onAppQr}>{t('dealer_menu_app_qr')}</button>
      </div>
      <span className="muted">{t('dealer_menu_layout')}</span>
      <Segmented value={mode} onChange={setMode}
        options={LAYOUT_OPTIONS.map((m) => ({ value: m, label: t(`dealer_layout_opt_${m}`) }))} />
    </div>
  );
}
