/** Floor view logic: status groups, attention rows, durations. Pure (tested). */

export type FloorGroup = 'ready' | 'no_dealer' | 'dealing' | 'waiting' | 'auto' | 'closed' | 'other';
export const GROUP_ORDER: readonly FloorGroup[] = ['ready', 'no_dealer', 'dealing', 'waiting', 'auto', 'closed', 'other'];

export interface FloorTable {
  id: string;
  name: string;
  kind: string;
  status: string;
  group: FloorGroup;
  dealerId: string | null;
  dealerName: string | null;
  isAutoDeal: boolean;
  isSimulation: boolean;
  createdAt: string;
  lastHandAt: string | null;
  totalHands: number;
  activeHandStatus: string | null;
  activeHandNumber: number | null;
  liveCoupons: number;
  couponExposureCents: number;
  joinCode: string;
  game: string;
  featured: boolean;
  tournamentId: string | null;
  tournamentName: string | null;
}

export type Severity = 'danger' | 'attention' | 'waiting';
export type AlertCode =
  | 'level_locked' | 'requests_waiting' | 'sim_budget' | 'no_dealer' | 'drift_unknown' | 'drift' | 'idle' | 'tournament_soon';

export interface FloorAlert {
  severity: Severity;
  code: AlertCode;
  params: Record<string, string | number>;
  tableId?: string;
  tournamentId?: string;
}

export interface Dashboard {
  stats: { openTables: number; dealing: number; liveCoupons: number; exposureCents: number; pendingPoints: number; pendingJoins: number; levelLocked: boolean };
  alerts: FloorAlert[];
  allClear: boolean;
  tables: FloorTable[];
  serverTime: string;
}

export interface TableGroup { group: FloorGroup; tables: FloorTable[] }

/** Non-empty groups in floor order; tables keep their server order inside a group. */
export function groupTables(tables: readonly FloorTable[]): TableGroup[] {
  return GROUP_ORDER
    .map((group) => ({ group, tables: tables.filter((t) => t.group === group) }))
    .filter((g) => g.tables.length > 0);
}

export interface Duration { key: 'insp_dur_min' | 'insp_dur_hm' | 'insp_dur_days'; params: Record<string, number> }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TWO_DAYS = 48 * HOUR;

/** "n min", "h h m min" under 48 h, else "n days". */
export function duration(ms: number): Duration {
  const safe = Math.max(0, ms);
  if (safe < HOUR) return { key: 'insp_dur_min', params: { n: Math.floor(safe / MINUTE) } };
  if (safe < TWO_DAYS) return { key: 'insp_dur_hm', params: { h: Math.floor(safe / HOUR), m: Math.floor((safe % HOUR) / MINUTE) } };
  return { key: 'insp_dur_days', params: { n: Math.floor(safe / (24 * HOUR)) } };
}

export type AlertAction = 'change_level' | 'open_requests' | 'open_simulation' | 'assign_dealer' | 'open_table' | 'open_tournaments' | null;

const ACTIONS: Record<AlertCode, AlertAction> = {
  level_locked: 'change_level',
  requests_waiting: 'open_requests',
  sim_budget: 'open_simulation',
  no_dealer: 'assign_dealer',
  drift_unknown: null,
  drift: null,
  idle: 'open_table',
  tournament_soon: 'open_tournaments',
};

/** Translation key, params and the action button of an attention row. */
export function alertView(alert: FloorAlert): { key: string; params: Record<string, string | number>; action: AlertAction } {
  return { key: `insp_alert_${alert.code}`, params: alert.params, action: ACTIONS[alert.code] };
}

/** Closed tables are folded behind "Show closed tables (n)". */
export function splitClosed(groups: readonly TableGroup[]): { visible: TableGroup[]; closed: TableGroup | null } {
  return {
    visible: groups.filter((g) => g.group !== 'closed'),
    closed: groups.find((g) => g.group === 'closed') ?? null,
  };
}

/** Status chip per group (CSS badge class and label key). */
export function groupChip(group: FloorGroup): { cls: string; key: string } {
  const cls: Record<FloorGroup, string> = {
    ready: 'gold', no_dealer: 'closed', dealing: 'live', waiting: 'open', auto: 'live', closed: '', other: '',
  };
  return { cls: cls[group], key: `insp_group_${group}` };
}
