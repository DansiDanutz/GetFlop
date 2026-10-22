import { and, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, hands, ledgerEntries, memberships } from '../../db/schema/index.js';
import type { Club } from '../clubs/access.js';

export const SETUP_STEPS = ['photo', 'table', 'dealer', 'players', 'points'] as const;
export type SetupKey = (typeof SETUP_STEPS)[number] | 'level';

export interface SetupStep { readonly key: SetupKey; readonly done: boolean; readonly optional: boolean }
export interface Setup { readonly complete: boolean; readonly done: number; readonly total: number; readonly steps: SetupStep[] }

const exists = async (q: Promise<{ n: number }[]>): Promise<boolean> => ((await q)[0]?.n ?? 0) > 0;

/** "First steps" checklist (03 §3). Each step ticks itself from what already happened in the club. */
export async function clubSetup(db: DbOrTx, club: Club): Promise<Setup> {
  const clubId = club.id;
  const settings = club.settings as Record<string, unknown>;
  const [table, dealer, players, points] = await Promise.all([
    exists(db.select({ n: count() }).from(clubTables)
      .where(and(eq(clubTables.clubId, clubId), sql`(${clubTables.status} = 'open' or ${clubTables.lastHandNumber} > 0)`))),
    Promise.all([
      exists(db.select({ n: count() }).from(memberships)
        .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'), sql`'dealer' = any(${memberships.roles})`))),
      exists(db.select({ n: count() }).from(hands).where(and(eq(hands.clubId, clubId), isNotNull(hands.dealerId)))),
    ]).then(([a, b]) => a || b),
    exists(db.select({ n: count() }).from(memberships)
      .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'), ne(memberships.userId, club.ownerId))))
      .then((joined) => joined || typeof settings.inviteSharedAt === 'string'),
    exists(db.select({ n: count() }).from(ledgerEntries)
      .where(and(eq(ledgerEntries.clubId, clubId), inArray(ledgerEntries.kind, ['deposit', 'reload'])))),
  ]);
  const required: SetupStep[] = [
    { key: 'photo', done: Boolean(club.photoUrl), optional: false },
    { key: 'table', done: table, optional: false },
    { key: 'dealer', done: dealer, optional: false },
    { key: 'players', done: players, optional: false },
    { key: 'points', done: points, optional: false },
  ];
  const done = required.filter((s) => s.done).length;
  return {
    complete: done === required.length, done, total: required.length,
    steps: [...required, { key: 'level', done: club.level !== 'starter', optional: true }],
  };
}
