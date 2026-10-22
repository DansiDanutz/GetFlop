import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubTables } from '../../db/schema/index.js';

export interface TableTarget { readonly id: string; readonly name: string; readonly hasDealer: boolean }
export interface TournamentTarget {
  readonly id: string;
  readonly name: string;
  readonly startsAt: string | null;
  /** upcoming | running */
  readonly status: string;
}

/**
 * The tournaments module plugs in here (call `registerTournamentSource` at the top level of its
 * register.ts). Without a source, the "Register" button has no targets and tournament entry is
 * inferred from tournament coupons only.
 */
export interface TournamentSource {
  /** Upcoming or running tournaments of the club that players can still open. */
  targets(db: DbOrTx, clubId: string, now: Date): Promise<readonly TournamentTarget[]>;
  /** Users who entered any tournament of the club at or after `since`. */
  entrants(db: DbOrTx, clubId: string, since: Date): Promise<readonly string[]>;
  /** Of `userIds`, those who registered for `tournamentId` at or after `since`. */
  registeredSince(db: DbOrTx, tournamentId: string, userIds: readonly string[], since: Date): Promise<readonly string[]>;
}

let tournamentSource: TournamentSource | null = null;

export function registerTournamentSource(source: TournamentSource | null): void {
  tournamentSource = source;
}

export function getTournamentSource(): TournamentSource | null {
  return tournamentSource;
}

/** Open Ring Game tables a "Join" button can point to. */
export async function openTables(db: DbOrTx, clubId: string): Promise<TableTarget[]> {
  const rows = await db.select({ id: clubTables.id, name: clubTables.name, dealerId: clubTables.dealerId, isAutoDeal: clubTables.isAutoDeal })
    .from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.kind, 'cash'), eq(clubTables.status, 'open')))
    .orderBy(asc(clubTables.name));
  return rows.map((r) => ({ id: r.id, name: r.name, hasDealer: Boolean(r.dealerId) || r.isAutoDeal }));
}

export async function tournamentTargets(db: DbOrTx, clubId: string, now: Date): Promise<TournamentTarget[]> {
  return tournamentSource ? [...await tournamentSource.targets(db, clubId, now)] : [];
}

export async function listTargets(db: DbOrTx, clubId: string, now: Date) {
  const [tables, tournaments] = await Promise.all([openTables(db, clubId), tournamentTargets(db, clubId, now)]);
  return { tables, tournaments };
}
