import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount, dateTime, parsePoints, points } from '../../lib/format';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { newIdempotencyKey, ownerApi, type Supply } from './api';
import './owner.css';

/** Points supply statement, "How it adds up", inspectors' stock and Mint (04 §2–3). */
export function PointsSupplyPage() {
  const t = useT();
  const { context } = useSession();
  const clubId = context?.club.id ?? '';
  const isOwner = Boolean(context?.roles.includes('owner'));
  const [params, setParams] = useSearchParams();
  const supply = useQuery({ queryKey: ['owner', 'supply', clubId], queryFn: () => ownerApi.supply(clubId), enabled: Boolean(clubId) });
  const detail = useQuery({ queryKey: ['owner', 'supply-detail', clubId], queryFn: () => ownerApi.supplyDetail(clubId), enabled: Boolean(clubId) });
  const [mintOpen, setMintOpen] = useState(Boolean(params.get('mint')));
  const s = supply.data;

  const preset = params.get('for') === 'stock'
    ? t('own_mint_reason_stock', { name: params.get('name') ?? '' })
    : params.get('for') === 'send' ? t('own_mint_reason_send', { name: params.get('name') ?? '' }) : '';

  return (
    <StaffShell>
      <h1>{t('own_points_title')}</h1>
      <p className="muted">{t('own_points_intro')}</p>
      {supply.isLoading && <Spinner />}
      {s && <Statement s={s} reservedCents={detail.data?.reservedCents ?? 0} />}
      {s && s.pool < 0 && (
        <div className="banner danger stack">
          <span>{t('own_pool_below_zero', { amount: amount(-s.pool) })}</span>
          {isOwner && <button type="button" className="btn primary" onClick={() => setMintOpen(true)}>{t('own_mint_points')}</button>}
        </div>
      )}
      {isOwner && <button type="button" className="btn primary block" onClick={() => setMintOpen(true)}>{t('own_mint_points')}</button>}
      {detail.data && detail.data.stocks.length > 0 && (
        <section className="stack">
          <h3>{t('own_inspector_stock')}</h3>
          <div className="card tight">
            {detail.data.stocks.map((x) => <div key={x.userId} className="own-line"><span>{x.name}</span><strong>{amount(x.stockCents)}</strong></div>)}
          </div>
        </section>
      )}
      {detail.data && detail.data.mints.length > 0 && (
        <section className="stack">
          <h3>{t('own_recent_mints')}</h3>
          <div className="card tight">
            {detail.data.mints.map((x) => (
              <div key={x.id} className="own-line">
                <span>{x.note}<span className="own-note" style={{ display: 'block' }}>{dateTime(x.createdAt)}{x.by && ` · ${t('own_by_name', { name: x.by })}`}</span></span>
                <strong>{amount(x.amountCents)}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {isOwner && s && (
        <MintSheet open={mintOpen} clubId={clubId} pool={s.pool}
          initialAmount={params.get('mint') ?? ''} initialReason={preset}
          onClose={() => { setMintOpen(false); if (params.get('mint')) setParams({}, { replace: true }); }} />
      )}
    </StaffShell>
  );
}

function Statement({ s, reservedCents }: { s: Supply; reservedCents: number }) {
  const t = useT();
  const held = s.pool + s.inStocks + s.inWallets + s.riding + s.inTournaments;
  return (
    <section className="card">
      <h3>{t('own_adds_up')}</h3>
      <div className="own-line"><span>{t('own_pool')}</span><strong>{amount(s.pool)}</strong></div>
      <div className="own-line"><span>{t('own_in_stocks')}</span><strong>{amount(s.inStocks)}</strong></div>
      <div className="own-line"><span>{t('own_in_wallets')}</span><strong>{amount(s.inWallets)}</strong></div>
      <div className="own-line"><span>{t('own_riding')}</span><strong>{amount(s.riding)}</strong></div>
      {s.inTournaments > 0 && <div className="own-line"><span>{t('own_in_tournaments')}</span><strong>{amount(s.inTournaments)}</strong></div>}
      <div className="own-line total"><span>{t('own_held_total')}</span><strong>{amount(held)}</strong></div>
      <div className="own-line total"><span>{t('own_issued')}</span><strong>{amount(s.issued)}</strong></div>
      <div className="own-line"><span className="muted">{t('own_game_played')}</span><span>{amount(s.gameBurned)}</span></div>
      <div className="own-line"><span className="muted">{t('own_game_won')}</span><span>{amount(s.gameMinted)}</span></div>
      {reservedCents > 0 && <div className="own-line"><span className="muted">{t('own_reserved')}</span><span>{amount(reservedCents)}</span></div>}
      <div className={`banner ${s.drift === 0 ? 'ok' : 'danger'}`} style={{ marginTop: 12 }}>
        {s.drift === 0 ? t('own_check_ok') : t('own_check_off', { amount: amount(Math.abs(s.drift)) })}
      </div>
    </section>
  );
}

interface MintProps { open: boolean; clubId: string; pool: number; initialAmount: string; initialReason: string; onClose: () => void }

function MintSheet({ open, clubId, pool, initialAmount, initialReason, onClose }: MintProps) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(initialAmount);
  const [reason, setReason] = useState(initialReason);
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setText(initialAmount); setReason(initialReason); setKey(newIdempotencyKey()); } }, [open, initialAmount, initialReason]);
  const cents = parsePoints(text);
  const presets = [
    ...(pool < 0 ? [{ label: t('own_mint_reason_zero'), amount: points(-pool) }] : []),
    ...(initialReason ? [{ label: initialReason, amount: initialAmount }] : []),
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cents || !reason.trim()) return;
    setBusy(true);
    try {
      qc.setQueryData(['owner', 'supply', clubId], await ownerApi.mint(clubId, text, reason.trim(), key));
      await qc.invalidateQueries({ queryKey: ['owner', 'supply-detail', clubId] });
      toast.show(t('own_minted', { amount: amount(cents) }), 'success');
      onClose();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('own_mint_points')}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{t('own_mint_hint')}</p>
        {presets.length > 0 && (
          <div className="own-chips">
            {presets.map((p) => <button key={p.label} type="button" className="chip" onClick={() => { setReason(p.label); setText(p.amount); }}>{p.label}</button>)}
          </div>
        )}
        <label>{t('own_amount')}<input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} /></label>
        {text && !cents && <span className="field-error">{t('err_points_amount_invalid')}</span>}
        <label>{t('own_mint_reason')}<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="btn primary block" disabled={busy || !cents || !reason.trim()}>{t('own_mint_cta')}</button>
      </form>
    </Sheet>
  );
}
