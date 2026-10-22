import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { TopBar } from '../../components/TopBar';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { useSession } from '../../state/session';
import { dealerApi, dealerKeys, type DealerTable, type SitResponse } from './api';
import { useOnce } from './DealerShell';
import { AppQrSheet } from './QrSheets';
import { SeatConflictSheet } from './SeatConflictSheet';
import { AvailableTableCard, HeldPanel, MyTableCard, NoticeList, PendingPanel } from './TableCards';

const AVAILABLE_REFRESH_MS = 15_000;
const SEAT_CONFLICT_CODES = new Set(['dealer.holds_other', 'dealer.you_deal_elsewhere']);

export function DealerTables() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { context, selectClub } = useSession();
  const mine = useQuery({ queryKey: dealerKeys.tables, queryFn: dealerApi.tables });
  const avail = useQuery({ queryKey: dealerKeys.available, queryFn: dealerApi.available, refetchInterval: AVAILABLE_REFRESH_MS });
  const notices = useQuery({ queryKey: dealerKeys.notices, queryFn: dealerApi.notices });
  const [target, setTarget] = useState<DealerTable | null>(null);
  const [busy, setBusy] = useState(false);
  const [appQr, setAppQr] = useState(false);
  const [help, setHelp] = useState(false);
  const [welcome, welcomeDone] = useOnce('getflop_dealer_welcome');
  const [coach, coachDone] = useOnce('getflop_dealer_coach_sit');

  const held = mine.data?.tables[0] ?? null;
  const heldHere = held !== null && held.clubId === context?.club.id;
  const pending = avail.data?.pending ?? null;
  const needsApproval = avail.data?.needsApproval ?? false;
  const refresh = () => qc.invalidateQueries({ queryKey: dealerKeys.all });

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await action(); } catch (err) {
      toast.error(err);
      if (err instanceof ApiError && SEAT_CONFLICT_CODES.has(err.code)) void refresh();
    } finally { setBusy(false); }
  }

  function afterSit(res: SitResponse, table: DealerTable): void {
    void refresh();
    if (res.status === 'seated') {
      toast.show(t('dealer_seated_toast'), 'success');
      navigate(`/dealer/table/${res.table.id}`);
    } else {
      toast.show(t('dealer_asked_toast', { table: table.name }));
    }
  }

  function onSit(table: DealerTable): void {
    coachDone();
    if (held && held.id !== table.id) { setTarget(table); return; }
    void run(async () => afterSit(await dealerApi.sit(table.id), table));
  }

  function onSwitch(): void {
    if (!held || !target) return;
    const table = target;
    setTarget(null);
    void run(async () => afterSit(await dealerApi.switchTo(table.id, held.id), table));
  }

  async function goToHeld(): Promise<void> {
    if (!held) return;
    setTarget(null);
    if (held.clubId !== context?.club.id) await selectClub(held.clubId);
    navigate(`/dealer/table/${held.id}`);
  }

  const leaveHeld = () => run(async () => {
    const res = await dealerApi.leaveHeld();
    toast.show(t('dealer_held_left', res), 'success');
    await refresh();
  });

  const cancelPending = (id: string) => run(async () => {
    await dealerApi.cancelRequest(id);
    toast.show(t('dealer_request_cancelled'));
    await refresh();
  });

  const readNotice = (id: string) => run(async () => {
    await dealerApi.readNotice(id);
    await qc.invalidateQueries({ queryKey: dealerKeys.notices });
  });

  const closeWelcome = () => { welcomeDone(); setHelp(false); };
  const tables = avail.data?.tables ?? [];
  return (
    <div className="screen">
      <TopBar subtitle={t('dealer_title')} onHelp={() => setHelp(true)} status={
        <button type="button" className="icon-btn" aria-label={t('dealer_menu_app_qr')} onClick={() => setAppQr(true)}>QR</button>
      } />
      <div className="screen-body">
        {notices.data && notices.data.notices.length > 0 && <NoticeList notices={notices.data.notices} onRead={(id) => void readNotice(id)} />}
        {held && !heldHere && <HeldPanel table={held} busy={busy} onLeave={() => void leaveHeld()} />}

        <h2 className="section-title">{t('dealer_my_tables')}</h2>
        {mine.isLoading && <Spinner />}
        {heldHere && <MyTableCard table={held} onOpen={() => navigate(`/dealer/table/${held.id}`)} />}
        {!mine.isLoading && !heldHere && <Empty icon="♠" title={t('dealer_empty')} />}

        {pending && <PendingPanel request={pending} busy={busy} onCancel={() => void cancelPending(pending.id)} />}

        <h2 className="section-title">{t('dealer_available')}</h2>
        {avail.isLoading && <Spinner />}
        {avail.isError && <div className="banner danger">{t('err_generic')}</div>}
        {avail.data && tables.length === 0 && <p className="muted">{t('dealer_no_tables')}</p>}
        <div className="stack">
          {tables.map((table, i) => (
            <AvailableTableCard key={table.id} table={table} needsApproval={needsApproval} coach={coach && !welcome && i === 0}
              disabled={busy || (pending !== null && needsApproval)} onSit={() => onSit(table)} />
          ))}
        </div>
      </div>

      <SeatConflictSheet held={held} target={target} needsApproval={needsApproval} busy={busy}
        onSwitch={onSwitch} onGoToHeld={() => void goToHeld()} onClose={() => setTarget(null)} />
      <AppQrSheet open={appQr} onClose={() => setAppQr(false)} />
      <Sheet open={welcome || help} onClose={closeWelcome} title={t('dealer_welcome_title')}>
        <p className="muted">{t('dealer_welcome_body')}</p>
        <button type="button" className="btn primary block" onClick={closeWelcome}>{t('dealer_welcome_ok')}</button>
      </Sheet>
    </div>
  );
}
