import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { tournamentEntries, tournamentEvents, tournaments, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';

export type TournamentRow = typeof tournaments.$inferSelect;
export type EntryRow = typeof tournamentEntries.$inferSelect;

/** Tournament-chip table limits: the engine sees no maximum; level rules are enforced by the pre-check. */
export const TOURNAMENT_TABLE_LIMITS = {
  minCents: 1,
  maxCents: 1_000_000_000_000,
  couponCapCents: 1_000_000_000_000,
  maxRounds: 9_999,
  marketMaxCents: {},
};

export const tournamentRoom = (id: string) => `tournament:${id}`;

export async function getTournament(db: DbOrTx, id: string, lock = false): Promise<TournamentRow> {
  const q = db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new AppError('trm.not_found', 404);
  return row;
}

export async function tournamentOfTable(db: DbOrTx, tableId: string, tournamentId: string | null): Promise<TournamentRow | null> {
  if (!tournamentId) return null;
  const [row] = await db.select().from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), eq(tournaments.tableId, tableId))).limit(1);
  return row ?? null;
}

export async function findEntry(db: DbOrTx, tournamentId: string, userId: string, lock = false): Promise<EntryRow | null> {
  const q = db.select().from(tournamentEntries)
    .where(and(eq(tournamentEntries.tournamentId, tournamentId), eq(tournamentEntries.userId, userId))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  return row ?? null;
}

/** Entries still in the event (everything except unregistered). */
export async function entriesOf(db: DbOrTx, tournamentId: string): Promise<EntryRow[]> {
  return db.select().from(tournamentEntries)
    .where(and(eq(tournamentEntries.tournamentId, tournamentId), ne(tournamentEntries.status, 'unregistered')));
}

export async function namesOf(db: DbOrTx, userIds: readonly string[]): Promise<Map<string, { name: string; isBot: boolean }>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.select({ id: users.id, username: users.username, displayName: users.displayName, isBot: users.isBot })
    .from(users).where(inArray(users.id, [...new Set(userIds)]));
  return new Map(rows.map((u) => [u.id, { name: u.displayName ?? u.username, isBot: u.isBot }]));
}

export type Severity = 'info' | 'warning' | 'error';

/** Appends to the tournament's event log (staff Logs view). */
export async function logEvent(db: DbOrTx, tournamentId: string, kind: string, data: Record<string, unknown> = {}, severity: Severity = 'info') {
  // clock_timestamp(): several events written in one transaction keep their order.
  await db.insert(tournamentEvents).values({ tournamentId, kind, data, severity, createdAt: sql`clock_timestamp()` });
}

/** Broadcasts a tournament event to the club (lobby, monitor) and the tournament room (TV). */
export function emitTournament(ctx: AppContext, t: Pick<TournamentRow, 'id' | 'clubId'>, event: string, payload: Record<string, unknown> = {}) {
  const body = { tournamentId: t.id, ...payload };
  ctx.events.emit(rooms.club(t.clubId), event, body);
  ctx.events.emit(tournamentRoom(t.id), event, body);
}
