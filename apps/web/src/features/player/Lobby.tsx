import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { getSocket, useTableRoom } from '../../lib/socket';
import { playerKeys, useBalance, usePlayerTables } from './data';
import type { TableView } from './types';
import './player.css';

export type LobbyStatus = 'open' | 'dealing' | 'waiting' | 'no_dealer';

/** Live status of a table card. */
export function lobbyStatus(table: Pick<TableView, 'currentHand' | 'dealerId' | 'isAutoDeal'>): LobbyStatus {
  if (table.currentHand?.status === 'betting_open') return 'open';
  if (table.currentHand?.status === 'betting_closed') return 'dealing';
  if (!table.dealerId && !table.isAutoDeal) return 'no_dealer';
  return 'waiting';
}

/** Table events that change a lobby card. */
const LOBBY_EVENTS = ['hand:started', 'hand:betting-closed', 'hand:settled', 'hand:cancelled', 'table:updated', 'table:closed'] as const;

const STATUS_BADGE: Record<LobbyStatus, string> = { open: 'open', dealing: 'closed', waiting: '', no_dealer: '' };

/** #/player: the club's open tables as cards. */
export function Lobby() {
  const t = useT();
  const q = usePlayerTables();
  const balance = useBalance().data;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tables = q.data?.tables ?? [];
  const [params] = useSearchParams();
  const linkedTable = params.get('table');
  useEffect(() => {
    // Other screens link a table as #/player?table=<id>.
    if (linkedTable) navigate(`/player/table/${encodeURIComponent(linkedTable)}`, { replace: true });
  }, [linkedTable, navigate]);
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => void qc.invalidateQueries({ queryKey: playerKeys.tables });
    for (const event of LOBBY_EVENTS) socket.on(event, refresh);
    return () => { for (const event of LOBBY_EVENTS) socket.off(event, refresh); };
  }, [qc]);

  return (
    <div className="screen">
      <TopBar status={balance && <span className="badge gold plain">{amount(balance.balanceCents)}</span>}
        onHelp={() => navigate('/player/rules')}
        menu={<button type="button" className="btn ghost block" onClick={() => navigate('/player/rules')}>{t('player_menu_rules')}</button>} />
      <div className="screen-body">
        <div className="row-between">
          <h1>{t('player_lobby_title')}</h1>
          {tables.length > 0 && <span className="faint">{t('player_lobby_count', { n: tables.length })}</span>}
        </div>
        {q.isLoading && <Spinner />}
        {q.isError && <div className="banner danger">{t('player_lobby_error')}</div>}
        {!q.isLoading && tables.length === 0 && <Empty icon="♣" title={t('player_lobby_empty')}>{t('player_lobby_empty_sub')}</Empty>}
        <div className="stack">
          {tables.map((table) => <TableCard key={table.id} table={table} onOpen={() => navigate(`/player/table/${table.id}`)} />)}
        </div>
      </div>
    </div>
  );
}

function TableCard({ table, onOpen }: { table: TableView; onOpen: () => void }) {
  const t = useT();
  useTableRoom(table.id);
  const status = lobbyStatus(table);
  const handNumber = table.currentHand?.handNumber ?? table.lastHandNumber;
  return (
    <button type="button" className="card clickable pl-table-card" onClick={onOpen}>
      <div className="pl-felt">
        {table.photoUrl ? <img src={table.photoUrl} alt="" /> : <span className="pl-felt-game">{t(`player_game_${table.game}`)}</span>}
        {table.featured && <span className="badge gold plain pl-featured">{t('player_featured')}</span>}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row-between">
          <strong className="truncate">{table.name}</strong>
          <span className={`badge ${STATUS_BADGE[status]}`}>{t(`player_lobby_status_${status}`)}</span>
        </div>
        <span className="muted">
          {t(`player_game_short_${table.game}`)}
          {handNumber > 0 && ` · ${t('player_recent_hand', { n: handNumber })}`}
        </span>
        <span className="faint">
          {table.dealerName ? t('player_lobby_dealer', { name: table.dealerName }) : table.isAutoDeal ? t('player_lobby_auto') : t('player_lobby_status_no_dealer')}
          {' · '}{t('player_lobby_from', { amount: amount(table.limits.minCents, table.unit) })}
        </span>
        <span className="btn primary block">{status === 'open' ? t('player_lobby_sit') : t('player_lobby_see')}</span>
      </div>
    </button>
  );
}
