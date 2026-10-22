import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { AdminShell } from './AdminShell';
import { useAdmin, type AdminTable, type BetRow, type HandBets, type HandsPage } from './api';
import { browserTz, handStatusKey, periodRange, type PeriodPreset } from './logic';
import { labelOr, Loadable, PeriodChips, Pts } from './parts';

const REASON_MAX = 500;
const VOIDABLE = new Set(['won', 'lost']);

function TablePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const tables = useAdmin<{ tables: AdminTable[] }>(['tables'], '/admin/tables');
  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const list = tables.data?.tables ?? [];
    return needle ? list.filter((x) => `${x.clubName} ${x.name}`.toLowerCase().includes(needle)) : list;
  }, [text, tables.data]);
  return (
    <div className="stack">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('admin_table_search')} aria-label={t('admin_table_search')} />
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('admin_table')}>
        <option value="">{t('admin_all_tables')}</option>
        {matches.map((x) => <option key={x.id} value={x.id}>{x.clubName} · {x.name}{x.kind === 'tournament' ? ` (${t('admin_kind_tournament')})` : ''}</option>)}
      </select>
    </div>
  );
}

export function HandsView() {
  const t = useT();
  const [tableId, setTableId] = useState('');
  const [handNumber, setHandNumber] = useState('');
  const [period, setPeriod] = useState<PeriodPreset>('all');
  const [openHand, setOpenHand] = useState<string | null>(null);
  const params = { ...periodRange(period, new Date(), browserTz()), tableId, handNumber: /^\d+$/.test(handNumber) ? handNumber : undefined };
  const query = useAdmin<HandsPage>(['hands', params], `/admin/hands${qs(params)}`);
  return (
    <div className="stack">
      <h1>{t('admin_hands_title')}</h1>
      <div className="filters">
        <TablePicker value={tableId} onChange={setTableId} />
        <input value={handNumber} onChange={(e) => setHandNumber(e.target.value)} inputMode="numeric" placeholder={t('admin_hand_number')} aria-label={t('admin_hand_number')} />
        <PeriodChips value={period} onChange={setPeriod} />
      </div>
      <Loadable query={query} empty={(d) => d.hands.length === 0}>
        {(d) => (
          <div className="stack">
            {d.truncated && <p className="muted">{t('admin_hands_latest', { n: d.limit })}</p>}
            {d.hands.map((h) => (
              <button key={h.id} type="button" className="card tight row-card clickable" onClick={() => setOpenHand(h.id)}>
                <div className="row-between">
                  <strong>#{h.handNumber} · {h.tableName}</strong>
                  <span className="faint">{h.flop ? h.flop.join(' ') : '—'}</span>
                </div>
                <span className="meta">{h.clubName} · {h.tableKind === 'tournament' ? t('admin_kind_tournament') : t('admin_kind_cash')} · {dateTime(h.createdAt)}</span>
                <span className="meta">
                  {t('admin_picks_status', { n: h.picks, status: t(handStatusKey(h.status)) })} · {t('admin_played')} <Pts cents={h.playedCents} unit={h.unit} />
                  {' · '}{t('admin_paid')} <Pts cents={h.paidCents} unit={h.unit} /> · {t('admin_club_result')} <Pts cents={h.resultCents} unit={h.unit} sign />
                </span>
              </button>
            ))}
          </div>
        )}
      </Loadable>
      <HandBetsSheet handId={openHand} onClose={() => setOpenHand(null)} />
    </div>
  );
}

export function HandsScreen() {
  return <AdminShell><HandsView /></AdminShell>;
}

function HandBetsSheet({ handId, onClose }: { handId: string | null; onClose: () => void }) {
  const t = useT();
  const query = useAdmin<HandBets>(['hand-bets', handId], `/admin/hands/${encodeURIComponent(handId ?? '')}/bets`, Boolean(handId));
  const [voiding, setVoiding] = useState<BetRow | null>(null);
  const hand = query.data?.hand;
  return (
    <>
      <Sheet open={Boolean(handId)} onClose={onClose} title={hand ? `#${hand.handNumber} · ${hand.tableName}` : t('admin_hand')}>
        {query.isLoading && <Spinner />}
        {query.data && (
          <div className="stack">
            <p className="muted">{hand?.clubName} · {hand?.flop ? hand.flop.join(' ') : '—'}</p>
            {query.data.bets.length === 0 && <p className="muted">{t('admin_no_picks')}</p>}
            {query.data.bets.map((b) => (
              <div key={b.id} className="list-row">
                <span className="grow">
                  <strong>{b.displayName}</strong> <span className="muted">@{b.username}</span>
                  <span className="muted" style={{ display: 'block' }}>
                    {b.marketName} ×{b.multiplier} · <Pts cents={b.stakeCents} unit={b.unit} /> · {labelOr(`admin_bet_${b.status}`, b.status)}
                    {b.status === 'won' && <> · <Pts cents={b.payoutCents} unit={b.unit} /></>}
                  </span>
                  {b.voidReason && <span className="faint" style={{ display: 'block' }}>{t('admin_void_reason_shown', { reason: b.voidReason })}</span>}
                </span>
                {VOIDABLE.has(b.status) && b.unit === 'points' && (
                  <button type="button" className="btn ghost" onClick={() => setVoiding(b)}>{t('admin_void')}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </Sheet>
      <VoidSheet bet={voiding} onClose={() => setVoiding(null)} />
    </>
  );
}

export function VoidSheet({ bet, onClose }: { bet: BetRow | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = reason.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!bet || !trimmed) return;
    setBusy(true);
    try {
      const res = await api.post<{ playerName: string }>(`/admin/bets/${encodeURIComponent(bet.id)}/void`, { reason: trimmed });
      toast.show(t('admin_void_done', { name: res.playerName }), 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      setReason('');
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={Boolean(bet)} onClose={onClose} title={t('admin_void_title')} modal>
      {bet && (
        <form className="stack" onSubmit={submit}>
          <p>{t('admin_void_pick', { name: bet.displayName, market: bet.marketName })}</p>
          <p className="muted">{bet.status === 'won' ? t('admin_void_effect_won') : t('admin_void_effect_lost')}</p>
          <label>{t('admin_void_reason')}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={REASON_MAX} required placeholder={t('admin_void_reason_hint')} />
          </label>
          {!trimmed && <span className="field-error">{t('admin_void_reason_required')}</span>}
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            <button type="submit" className="btn danger" disabled={busy || !trimmed}>{t('admin_void')}</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
