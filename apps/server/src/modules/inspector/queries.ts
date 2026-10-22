import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { bets, clubTables, coupons, floorFlags, hands, rooms, users } from '../../db/schema/index.js';
import type { Club } from '../clubs/access.js';
import type { BetFact } from './metrics.js';
import type { Range } from './time.js';

/** Rows of a raw `db.execute` on either driver (PGlite returns {rows}, node-postgres too; some return arrays). */
export function rowsOf<T>(result: unknown): T[] {
  const withRows = result as { rows?: T[] };
  return withRows.rows ?? (result as T[]);
}

export const displayName = (u: { displayName: string | null; username: string }): string => u.displayName ?? u.username;

export async function userNames(db: DbOrTx, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, displayName(u)]));
}

/** The platform simulation club is marked in its settings (`simulation: true`). */
export const isSimulationClub = (club: Pick<Club, 'settings'>): boolean => club.settings?.simulation === true;

/** A club created beyond the owner's one free club cannot open tables until it has a paid Level. */
export const isLevelLocked = (club: Pick<Club, 'settings' | 'status'>): boolean =>
  club.status === 'level_locked' || club.settings?.levelLocked === true;

/** Club "big pick" threshold in cents (settings.liveBigPoints, whole Points). Default 50 PTS. */
export function bigThresholdCents(club: Pick<Club, 'settings'>): number {
  const raw = Number(club.settings?.liveBigPoints);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 5_000;
}

export interface BetRowFact extends BetFact {
  readonly betId: string;
  readonly couponId: string;
  readonly handNumber: number;
  readonly tableId: string;
  readonly tableName: string;
  readonly tableKind: string;
  readonly roomId: string | null;
  readonly unit: string;
  readonly isBot: boolean;
  readonly userName: string;
  readonly dealtBy: string;
  readonly dealerId: string | null;
  readonly settledAt: Date;
}

export interface BetFilter {
  readonly range: Range;
  readonly tableIds?: readonly string[];
  readonly includeBots?: boolean;
  readonly source?: 'auto' | 'dealer';
  readonly dealerId?: string;
  readonly unit?: 'points' | 'chips';
}

/** Every settled pick (won or lost) whose flop was dealt in the range. */
export async function settledBets(db: DbOrTx, clubId: string, f: BetFilter): Promise<BetRowFact[]> {
  const conditions: SQL[] = [
    eq(bets.clubId, clubId), eq(hands.status, 'settled'), inArray(bets.status, ['won', 'lost']),
    gte(hands.settledAt, f.range.from), lt(hands.settledAt, f.range.to),
  ];
  if (f.tableIds && f.tableIds.length > 0) conditions.push(inArray(hands.tableId, [...f.tableIds]));
  if (!f.includeBots) conditions.push(eq(users.isBot, false));
  if (f.source) conditions.push(eq(hands.dealtBy, f.source));
  if (f.dealerId) conditions.push(eq(hands.dealerId, f.dealerId));
  if (f.unit) conditions.push(eq(coupons.unit, f.unit));
  const rows = await db.select({
    betId: bets.id, couponId: bets.couponId, handId: bets.handId, userId: bets.userId, market: bets.market,
    stakeCents: bets.stakeCents, multiplierX100: bets.multiplierX100, payoutCents: bets.payoutCents, status: bets.status,
    handNumber: hands.handNumber, tableId: hands.tableId, tableName: clubTables.name, tableKind: clubTables.kind,
    roomId: clubTables.roomId, unit: coupons.unit, isBot: users.isBot, username: users.username, displayName: users.displayName,
    dealtBy: hands.dealtBy, dealerId: hands.dealerId, settledAt: hands.settledAt,
  }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId))
    .innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .innerJoin(coupons, eq(coupons.id, bets.couponId))
    .innerJoin(users, eq(users.id, bets.userId))
    .where(and(...conditions));
  return rows.map(({ username, displayName: dn, settledAt, ...r }) => ({
    ...r, userName: dn ?? username, settledAt: settledAt ?? new Date(0),
  }));
}

export async function roomNames(db: DbOrTx, clubId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.clubId, clubId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── Tournaments (owned by another module): read defensively, skip when absent ──

export interface TournamentInfo {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly scheduledAt: Date | null;
}

const TOURNAMENT_COLUMNS = ['id', 'club_id', 'name', 'status', 'scheduled_at'];

async function tournamentsReadable(db: DbOrTx): Promise<boolean> {
  try {
    const cols = rowsOf<{ column_name: string }>(await db.execute(sql`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tournaments'`));
    const have = new Set(cols.map((c) => c.column_name));
    return TOURNAMENT_COLUMNS.every((c) => have.has(c));
  } catch {
    return false;
  }
}

/** Tournaments of a club (optionally only these ids). Empty when the tournaments table does not exist yet. */
export async function clubTournaments(db: DbOrTx, clubId: string, ids?: readonly string[]): Promise<TournamentInfo[]> {
  if (!(await tournamentsReadable(db))) return [];
  if (ids && ids.length === 0) return [];
  const idFilter = ids ? sql` and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const rows = rowsOf<{ id: string; name: string; status: string; scheduled_at: string | Date | null }>(await db.execute(sql`
    select id, name, status, scheduled_at from tournaments where club_id = ${clubId}${idFilter}`));
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, scheduledAt: r.scheduled_at ? new Date(r.scheduled_at) : null }));
}

// ── Floor flags ──

export async function readFlag<T extends Record<string, unknown>>(db: DbOrTx, key: string): Promise<T | null> {
  const [row] = await db.select().from(floorFlags).where(eq(floorFlags.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function writeFlag(db: DbOrTx, key: string, value: Record<string, unknown>, now: Date): Promise<void> {
  await db.insert(floorFlags).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: floorFlags.key, set: { value, updatedAt: now } });
}
