import { and, asc, eq, ilike, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { memberships, users } from '../../db/schema/index.js';
import { PLAYERS_LIMIT } from './constants.js';

export interface PlayerOption { readonly userId: string; readonly username: string; readonly displayName: string }

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Members a direct message can go to (search by name or username). */
export async function listPlayers(db: DbOrTx, clubId: string, selfId: string, query: string): Promise<PlayerOption[]> {
  const q = query.trim().slice(0, 40);
  const pattern = `%${escapeLike(q)}%`;
  const rows = await db.select({ userId: users.id, username: users.username, displayName: users.displayName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(
      eq(memberships.clubId, clubId), eq(memberships.status, 'active'), ne(memberships.userId, selfId),
      eq(users.isBot, false), eq(users.isActive, true),
      q ? or(ilike(users.username, pattern), ilike(users.displayName, pattern)) : undefined,
    ))
    .orderBy(asc(sql`lower(coalesce(${users.displayName}, ${users.username}))`))
    .limit(PLAYERS_LIMIT);
  return rows.map((r) => ({ userId: r.userId, username: r.username, displayName: r.displayName ?? r.username }));
}
