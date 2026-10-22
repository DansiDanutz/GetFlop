import { useT } from '../../../i18n/i18n';
import { amount } from '../../../lib/format';
import { duration, groupChip, type FloorTable } from '../model/floor';

interface Props {
  table: FloorTable;
  now: number;
  onAction: (action: 'open' | 'assign' | 'menu') => void;
}

/** One floor row: name, status chip, sub-lines, the main button and the "⋯" menu. */
export function TableRow({ table, now, onAction }: Props) {
  const t = useT();
  const chip = groupChip(table.group);
  const since = table.lastHandAt ? duration(now - Date.parse(table.lastHandAt)) : null;
  return (
    <div className="list-row insp-table-row">
      <div className="grow insp-rowtext">
        <div className="row">
          <strong className="truncate">{table.name}</strong>
          <span className={`badge ${chip.cls}`}>{t(chip.key)}</span>
        </div>
        <span className="muted insp-sub">
          {table.dealerName ? t('insp_dealt_by', { name: table.dealerName }) : table.isAutoDeal ? t('insp_auto_deal') : t('insp_no_dealer')}
          {table.activeHandNumber ? ` · ${t('insp_hand_n', { n: table.activeHandNumber })}` : ''}
        </span>
        <span className="faint insp-sub">
          {t('insp_hands_n', { n: table.totalHands })}
          {table.liveCoupons > 0 && ` · ${t('insp_live_coupons', { n: table.liveCoupons, amount: amount(table.couponExposureCents) })}`}
          {since && ` · ${t('insp_last_hand', { ago: t(since.key, since.params) })}`}
        </span>
      </div>
      {table.group === 'ready' && <button type="button" className="btn primary" onClick={() => onAction('open')}>{t('insp_act_open')}</button>}
      {table.group === 'no_dealer' && <button type="button" className="btn outline-gold" onClick={() => onAction('assign')}>{t('insp_act_assign')}</button>}
      <button type="button" className="icon-btn" aria-label={t('insp_more')} onClick={() => onAction('menu')}>⋯</button>
    </div>
  );
}
