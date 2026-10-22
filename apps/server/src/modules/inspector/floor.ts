/** Pure floor rules: table status groups and the attention list (07 §1.1, §1.3). */

export const IDLE_ALERT_MS = 8 * 60_000;
export const TOURNAMENT_SOON_MS = 10 * 60_000;
export const READY_WINDOW_MS = 14 * 86_400_000;

export type FloorGroup = 'ready' | 'no_dealer' | 'dealing' | 'waiting' | 'auto' | 'closed' | 'other';
export const GROUP_ORDER: readonly FloorGroup[] = ['ready', 'no_dealer', 'dealing', 'waiting', 'auto', 'closed', 'other'];

export interface FloorRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly dealerId: string | null;
  readonly dealerName: string | null;
  readonly isAutoDeal: boolean;
  readonly isSimulation: boolean;
  readonly createdAt: Date;
  readonly lastHandAt: Date | null;
  readonly totalHands: number;
  readonly activeHandStatus: string | null;
  readonly activeHandNumber: number | null;
  readonly liveCoupons: number;
  readonly couponExposureCents: number;
}

/**
 * Each table lands in exactly one group. Auto-deal tables are checked before
 * "dealing" because an auto-dealt table almost always has a live hand.
 */
export function classifyTable(row: FloorRow, now: Date): FloorGroup {
  if (row.status === 'closed') {
    const fresh = now.getTime() - row.createdAt.getTime() <= READY_WINDOW_MS;
    return row.kind === 'cash' && !row.isSimulation && row.totalHands === 0 && fresh ? 'ready' : 'closed';
  }
  if (row.status !== 'open') return 'other';
  if (row.isAutoDeal) return 'auto';
  if (!row.dealerId) return 'no_dealer';
  if (row.activeHandStatus) return 'dealing';
  return 'waiting';
}

export type Severity = 'danger' | 'attention' | 'waiting';
export type AlertCode =
  | 'level_locked' | 'requests_waiting' | 'sim_budget' | 'no_dealer' | 'drift_unknown' | 'drift' | 'idle' | 'tournament_soon';

export interface FloorAlert {
  readonly severity: Severity;
  readonly code: AlertCode;
  readonly params: Readonly<Record<string, string | number>>;
  readonly tableId?: string;
  readonly tournamentId?: string;
}

export type DriftResult = { readonly ok: true; readonly driftingCount: number; readonly worstDriftCents: number } | { readonly ok: false };

export interface UpcomingTournament {
  readonly id: string;
  readonly name: string;
  readonly scheduledAt: Date;
}

export interface AlertInput {
  readonly levelLocked: boolean;
  readonly pendingPoints: number;
  readonly simBudgetTripped: boolean;
  readonly drift: DriftResult;
  readonly rows: readonly FloorRow[];
  readonly tournaments: readonly UpcomingTournament[];
  readonly now: Date;
}

const minutesBetween = (a: Date, b: Date): number => Math.floor((b.getTime() - a.getTime()) / 60_000);
const isOpenManual = (r: FloorRow): boolean => r.status === 'open' && !r.isAutoDeal;

function tableAlerts(rows: readonly FloorRow[], now: Date) {
  const noDealer: FloorAlert[] = rows.filter((r) => isOpenManual(r) && !r.dealerId)
    .map((r) => ({ severity: 'danger', code: 'no_dealer', params: { table: r.name }, tableId: r.id }));
  const idle: FloorAlert[] = rows
    .filter((r) => isOpenManual(r) && r.dealerId && !r.activeHandStatus && r.lastHandAt
      && now.getTime() - r.lastHandAt.getTime() >= IDLE_ALERT_MS)
    .map((r) => ({
      severity: 'attention', code: 'idle', tableId: r.id,
      params: { table: r.name, dealer: r.dealerName ?? '', minutes: minutesBetween(r.lastHandAt!, now) },
    }));
  return { noDealer, idle };
}

function driftAlerts(drift: DriftResult): FloorAlert[] {
  if (!drift.ok) return [{ severity: 'attention', code: 'drift_unknown', params: {} }];
  if (drift.driftingCount > 0) {
    return [{ severity: 'danger', code: 'drift', params: { n: drift.driftingCount, largest: drift.worstDriftCents } }];
  }
  return [];
}

/** The "NEEDS YOU" list in priority order. Empty = ALL CLEAR. */
export function buildAlerts(input: AlertInput): FloorAlert[] {
  const { noDealer, idle } = tableAlerts(input.rows, input.now);
  const head: FloorAlert[] = [
    ...(input.levelLocked ? [{ severity: 'danger', code: 'level_locked', params: {} } as const] : []),
    ...(input.pendingPoints > 0 ? [{ severity: 'danger', code: 'requests_waiting', params: { n: input.pendingPoints } } as const] : []),
    ...(input.simBudgetTripped ? [{ severity: 'danger', code: 'sim_budget', params: {} } as const] : []),
  ];
  const soon: FloorAlert[] = input.tournaments
    .filter((t) => {
      const lead = t.scheduledAt.getTime() - input.now.getTime();
      return lead >= 0 && lead <= TOURNAMENT_SOON_MS;
    })
    .map((t) => ({
      severity: 'waiting', code: 'tournament_soon', tournamentId: t.id,
      params: { tournament: t.name, minutes: Math.ceil((t.scheduledAt.getTime() - input.now.getTime()) / 60_000) },
    }));
  return [...head, ...noDealer, ...driftAlerts(input.drift), ...idle, ...soon];
}
