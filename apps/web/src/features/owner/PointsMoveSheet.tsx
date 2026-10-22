import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { amount, parsePoints, points } from '../../lib/format';
import { ownerApi } from './api';
import { claimChips, sendChips } from './logic';

/** send = Send Out, claim = Claim Back, give / take = inspector stock (04 §4–5). */
export type MoveKind = 'send' | 'claim' | 'give' | 'take';

const NOTE_MAX = 200;

interface Props {
  open: boolean;
  kind: MoveKind;
  clubId: string;
  member: { userId: string; displayName: string; balanceCents: number; stockCents?: number };
  onClose: () => void;
  onDone: () => void;
}

export function PointsMoveSheet({ open, kind, clubId, member, onClose, onDone }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ cents: number; after: number } | null>(null);
  const [short, setShort] = useState<number | null>(null);
  useEffect(() => { if (open) { setText(''); setNote(''); setReceipt(null); setShort(null); } }, [open, kind]);

  const held = kind === 'claim' ? member.balanceCents : kind === 'take' ? member.stockCents ?? 0 : null;
  const chips = held === null ? sendChips() : claimChips(held);
  const cents = parsePoints(text);
  const over = held !== null && cents !== null && cents > held;
  const valid = cents !== null && cents > 0 && !over;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || cents === null) return;
    setBusy(true);
    setShort(null);
    try {
      const after = kind === 'send' || kind === 'claim'
        ? (await ownerApi.sendOrClaim(clubId, member.userId, kind === 'send' ? 'load' : 'withdraw', cents, note.trim() || undefined)).balanceCents
        : (await ownerApi.stock(clubId, member.userId, kind, cents, note.trim() || undefined)).stockCents;
      setReceipt({ cents, after });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'points.pool_short_owner') setShort(cents);
      else toast.error(err);
    } finally { setBusy(false); }
  }

  function mintShortfall() {
    if (short === null) return;
    const reason = kind === 'give' ? 'stock' : 'send';
    navigate(`/club/points?mint=${(short / 100).toFixed(2)}&for=${reason}&name=${encodeURIComponent(member.displayName)}`);
  }

  return (
    <Sheet open={open} onClose={onClose} title={t(`own_move_${kind}_title`, { name: member.displayName })}>
      {receipt ? (
        <div className="stack">
          <div className="own-receipt">
            <span className="kind">{t(`own_receipt_${kind}`)}</span>
            <span className="big">{amount(receipt.cents)}</span>
            <span className="muted">{t(kind === 'give' || kind === 'take' ? 'own_receipt_stock_after' : 'own_receipt_balance_after', { amount: amount(receipt.after) })}</span>
          </div>
          <button type="button" className="btn primary block" onClick={onClose}>{t('done')}</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted">{t(`own_move_${kind}_hint`)}</p>
          {held !== null && <div className="own-line"><span>{t(kind === 'claim' ? 'own_balance' : 'own_stock')}</span><strong>{amount(held)}</strong></div>}
          <label>{t('own_amount')}
            <input inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="0" aria-invalid={over} />
          </label>
          <div className="own-chips">
            {chips.map((c) => <button key={c} type="button" className="chip" onClick={() => setText(points(c))}>{points(c)}</button>)}
            {held !== null && held > 0 && (
              <button type="button" className="chip" onClick={() => setText((held / 100).toFixed(2).replace(/\.00$/, ''))}>
                {t(kind === 'claim' ? 'own_whole_balance' : 'own_whole_stock', { amount: points(held) })}
              </button>
            )}
          </div>
          {over && <span className="field-error">{t(kind === 'claim' ? 'own_over_balance' : 'own_over_stock')}</span>}
          {text && cents === null && <span className="field-error">{t('err_points_amount_invalid')}</span>}
          <label>{t('own_note')}
            <input value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={t('own_note_placeholder')} />
          </label>
          {short !== null && (
            <div className="banner danger stack">
              <span>{t('own_pool_short', { needed: amount(short) })}</span>
              <button type="button" className="btn primary" onClick={mintShortfall}>{t('own_mint_points')}</button>
            </div>
          )}
          <button className="btn primary block" disabled={!valid || busy}>{t(`own_move_${kind}_cta`)}</button>
        </form>
      )}
    </Sheet>
  );
}
