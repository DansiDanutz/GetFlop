import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Segmented, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { amount, dateTime } from '../../lib/format';
import { getLanguage, useT } from '../../i18n/i18n';
import { allAmountText, checkAmount, guidanceKey, pendingFor, quickChips, type PointsMode } from './amounts';
import { meKeys, useBalance, useMyGames, useRequests } from './data';
import './me.css';

interface PointsSheetProps {
  open: boolean;
  onClose: () => void;
  initialMode?: PointsMode;
}

const ENDPOINT: Record<PointsMode, string> = { request: '/player/reload-request', return: '/player/cashout-request' };
const RECENT_SHOWN = 3;

/** Balance in the club, riding now, and a Points request or return (spec 06 §5, 04 §6). */
export function PointsSheet({ open, onClose, initialMode = 'request' }: PointsSheetProps) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<PointsMode>(initialMode);
  const [text, setText] = useState('');
  const balance = useBalance(open);
  const games = useMyGames();
  const requests = useRequests(open);
  const balanceCents = balance.data?.balanceCents ?? 0;
  const check = checkAmount(text, mode, balanceCents);
  const pending = pendingFor(requests.data, mode);

  const send = useMutation({
    mutationFn: (cents: number) => api.post(ENDPOINT[mode], { amountCents: cents }),
    onSuccess: async (_data, cents) => {
      toast.show(t(mode === 'request' ? 'me_points_sent_request' : 'me_points_sent_return', { amount: amount(cents) }), 'success');
      setText('');
      await qc.invalidateQueries({ queryKey: meKeys.requests });
    },
    onError: (err) => toast.error(err),
  });

  const switchMode = (next: PointsMode) => { setMode(next); setText(''); };
  const recent = [...(requests.data?.reloads ?? []), ...(requests.data?.cashouts ?? [])]
    .filter((r) => r.status !== 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_SHOWN);
  const showError = text.trim() !== '' && !check.ok;

  return (
    <Sheet open={open} onClose={onClose} title={t('me_points_title')}>
      {balance.isLoading ? <Spinner /> : (
        <div className="stack">
          <div className="grid-2">
            <div className="tile"><span className="label">{t('me_points_balance')}</span><span className="value">{amount(balanceCents)}</span></div>
            <div className="tile"><span className="label">{t('me_points_riding')}</span><span className="value">{amount(games.data?.totals.stillAtStakeCents ?? 0)}</span></div>
          </div>
          <Segmented<PointsMode> value={mode} onChange={switchMode} options={[
            { value: 'request', label: t('me_points_mode_request') },
            { value: 'return', label: t('me_points_mode_return') },
          ]} />
          <p className="muted">{t(mode === 'request' ? 'me_points_explain_request' : 'me_points_explain_return')}</p>
          {pending ? (
            <div className="banner" role="status">{t('me_points_pending', { amount: amount(pending.amountCents) })}</div>
          ) : (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (check.ok) send.mutate(check.cents); }}>
              <input className="me-amount" inputMode="decimal" aria-label={t('me_points_amount')} placeholder="0"
                value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))}
                disabled={mode === 'return' && balanceCents <= 0} />
              <div className="chips">
                {quickChips(mode, balanceCents).map((c) => (
                  <button key={c} type="button" className="chip" onClick={() => setText(allAmountText(c, getLanguage()))}>{amount(c)}</button>
                ))}
                {mode === 'return' && balanceCents > 0 && (
                  <button type="button" className="chip" onClick={() => setText(allAmountText(balanceCents, getLanguage()))}>{t('me_points_all')}</button>
                )}
              </div>
              <p className={showError ? 'field-error' : 'faint'} role={showError ? 'alert' : undefined}>
                {showError ? t(`me_points_error_${check.error}`, { balance: amount(balanceCents) }) : t(guidanceKey(mode, balanceCents), { balance: amount(balanceCents) })}
              </p>
              <button className="btn primary block lg" disabled={!check.ok || send.isPending}>
                {t('me_points_send', { amount: check.ok ? amount(check.cents) : '' })}
              </button>
            </form>
          )}
          {recent.length > 0 && (
            <div className="stack">
              <span className="eyebrow">{t('me_points_recent')}</span>
              {recent.map((r) => (
                <div key={r.id} className="me-move">
                  <span>
                    <span style={{ display: 'block' }}>{t(r.kind === 'load' ? 'me_points_kind_request' : 'me_points_kind_return')}</span>
                    <span className="faint">{dateTime(r.createdAt)}</span>
                  </span>
                  <span className="amt">{amount(r.amountCents)}</span>
                  <span className={`badge ${r.status === 'approved' ? 'live' : 'closed'}`}>{t(`me_request_status_${r.status}`)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
