import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CountdownRing } from '../../components/Countdown';
import { Flop } from '../../components/PlayingCard';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { TopBar } from '../../components/TopBar';
import { HandBadge, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { getSocket, onSocketStatus, useTableRoom } from '../../lib/socket';
import { useSession } from '../../state/session';
import { ActionDock } from './ActionDock';
import { dealerApi, dealerKeys, dockMode, isLive, type Hand } from './api';
import { DealerMenu } from './DealerMenu';
import { useOnce } from './DealerShell';
import { FlopPicker } from './FlopPicker';
import { AppQrSheet, TableQrSheet } from './QrSheets';
import { RecentHands } from './RecentHands';

const TABLE_EVENTS = ['hand:started', 'hand:no-more-bets', 'hand:betting-closed', 'hand:settled', 'hand:cancelled', 'table:updated'] as const;
const PICKS_BADGE: Record<string, string> = {
  betting_open: 'picks_open', betting_closed: 'picks_closed', settled: 'status_settled', cancelled: 'status_cancelled',
};

function ringSeconds(hand: Hand): number {
  if (!hand.bettingClosesAt) return 0;
  return Math.max(1, Math.round((new Date(hand.bettingClosesAt).getTime() - new Date(hand.createdAt).getTime()) / 1000));
}

/** Keeps the console in sync with the table room; refetches after reconnects. */
function useConsoleSync(tableId: string): () => void {
  const qc = useQueryClient();
  useTableRoom(tableId);
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: dealerKeys.current(tableId) });
    void qc.invalidateQueries({ queryKey: dealerKeys.hands(tableId) });
  }, [qc, tableId]);
  useEffect(() => {
    const socket = getSocket();
    const mine = (p: unknown) => (p as { tableId?: string } | null)?.tableId === tableId;
    const onTable = (p: unknown) => { if (mine(p)) refresh(); };
    const onCoupon = (p: unknown) => { if (mine(p)) void qc.invalidateQueries({ queryKey: dealerKeys.current(tableId) }); };
    TABLE_EVENTS.forEach((e) => socket.on(e, onTable));
    socket.on('coupon:placed', onCoupon);
    return () => {
      TABLE_EVENTS.forEach((e) => socket.off(e, onTable));
      socket.off('coupon:placed', onCoupon);
    };
  }, [qc, tableId, refresh]);
  useEffect(() => onSocketStatus((s) => { if (s === 'connected') refresh(); }), [refresh]);
  return refresh;
}

export function DealerConsole() {
  const { tableId = '' } = useParams();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useSession();
  const refresh = useConsoleSync(tableId);
  const current = useQuery({ queryKey: dealerKeys.current(tableId), queryFn: () => dealerApi.current(tableId), enabled: Boolean(tableId) });
  const recent = useQuery({ queryKey: dealerKeys.hands(tableId), queryFn: () => dealerApi.hands(tableId), enabled: Boolean(tableId) });
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'stand' | null>(null);
  const [qr, setQr] = useState<'table' | 'app' | null>(null);
  const [coach, coachDone] = useOnce('getflop_dealer_coach_new_hand');

  const table = current.data?.table;
  const hand = current.data?.hand ?? null;
  const handRef = useRef<string | null>(null);
  handRef.current = isLive(hand) ? hand!.id : null;

  // The picker opens by itself when picks close, and closes when the hand is no longer waiting for its flop.
  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = hand?.status;
    if (prev === 'betting_open' && hand?.status === 'betting_closed') setPickerOpen(true);
    if (hand?.status !== 'betting_closed') setPickerOpen(false);
  }, [hand?.status, hand?.id]);

  async function run(action: () => Promise<unknown>, done?: () => void): Promise<void> {
    setBusy(true);
    try {
      await action();
      done?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (current.isLoading) return <div className="screen"><TopBar /><Spinner /></div>;
  if (!table) return <div className="screen"><TopBar /><div className="screen-body"><div className="banner danger">{t('err_generic')}</div></div></div>;

  const notMine = table.dealerId !== user?.id;
  const shownHand = hand ?? table.lastHand;
  const handNumber = hand?.handNumber ?? table.lastHandNumber;
  return (
    <div className="screen dealer-console">
      <TopBar subtitle={t('dealer_title')} menu={
        <DealerMenu onStandUp={() => setConfirm('stand')} onTableQr={() => setQr('table')} onAppQr={() => setQr('app')} />
      } />
      <div className="screen-body with-actions">
        <header className="console-head">
          <div className="grow stack-sm">
            <h1 className="truncate">{table.name}</h1>
            <span className="row wrap">
              {handNumber > 0 && <span className="badge gold plain">{t('dealer_hand_n', { n: handNumber })}</span>}
              <HandBadge status={hand?.status} label={t(PICKS_BADGE[hand?.status ?? ''] ?? 'status_waiting')} />
            </span>
          </div>
          {hand?.status === 'betting_open' && hand.bettingClosesAt && (
            <div className="console-ring"><CountdownRing endsAt={hand.bettingClosesAt} totalSeconds={ringSeconds(hand)} /></div>
          )}
        </header>
        {notMine && <div className="banner danger">{t('err_dealer_not_dealing')}</div>}

        <section className="console-flop" aria-live="polite">
          <Flop cards={isLive(hand) ? null : shownHand?.flop} />
          <span className="muted">{isLive(hand) ? t('dealer_flop_waiting') : shownHand ? t('dealer_flop_of', { n: shownHand.handNumber }) : ''}</span>
        </section>

        <h2 className="section-title">{t('dealer_recent')}</h2>
        {recent.isLoading ? <Spinner /> : <RecentHands hands={recent.data?.hands ?? []} unit={recent.data?.unit ?? table.unit} />}
      </div>

      {!notMine && (
        <ActionDock mode={dockMode(table, hand)} live={current.data?.live ?? { players: 0, picks: 0 }} busy={busy} closing={closing}
          coach={coach}
          onNewHand={() => { coachDone(); void run(() => dealerApi.startHand(tableId)); }}
          onNoMorePicks={() => { setClosing(true); void run(() => dealerApi.noMorePicks(tableId), () => setPickerOpen(true)).finally(() => setClosing(false)); }}
          onEnterFlop={() => setPickerOpen(true)}
          onCancel={() => setConfirm('cancel')} />
      )}

      {pickerOpen && hand && hand.status === 'betting_closed' && (
        <FlopPicker tableId={tableId} handId={hand.id} currentHandId={() => handRef.current}
          onClose={() => setPickerOpen(false)} onSettled={() => { setPickerOpen(false); refresh(); }} />
      )}

      <ConfirmSheet open={confirm === 'cancel'} danger busy={busy}
        title={t('dealer_cancel_title', { n: hand?.handNumber ?? '' })} body={t('dealer_cancel_body')}
        confirmLabel={t('dealer_cancel_confirm')} cancelLabel={t('dealer_cancel_keep')} onCancel={() => setConfirm(null)}
        onConfirm={() => void run(() => dealerApi.cancelHand(tableId), () => { setConfirm(null); toast.show(t('dealer_cancelled_toast')); })} />
      <ConfirmSheet open={confirm === 'stand'} danger busy={busy}
        title={t('dealer_stand_title', { table: table.name })} body={t('dealer_stand_body')}
        confirmLabel={t('dealer_stand_confirm')} cancelLabel={t('cancel')} onCancel={() => setConfirm(null)}
        onConfirm={() => void run(() => dealerApi.leave(tableId), () => {
          setConfirm(null);
          toast.show(t('dealer_stood_toast', { table: table.name }), 'success');
          navigate('/dealer');
        })} />
      <TableQrSheet open={qr === 'table'} onClose={() => setQr(null)} tableName={table.name} joinCode={table.joinCode} />
      <AppQrSheet open={qr === 'app'} onClose={() => setQr(null)} />
    </div>
  );
}
