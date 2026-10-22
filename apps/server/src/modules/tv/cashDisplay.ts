import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubTables, clubs, rooms as clubRooms } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { currentHand, popularMarkets, recentFlops, tvHand } from './handStats.js';
import type { TvSessionRow } from './service.js';

/**
 * Ring Game TV payload. Contains the table header, the join link, the current hand
 * (aggregates only), the most picked markets and the last flops. Never names,
 * balances or individual picks.
 */
export async function cashDisplay(ctx: AppContext, session: TvSessionRow) {
  const [row] = await ctx.db.select({ table: clubTables, clubName: clubs.name }).from(clubTables)
    .innerJoin(clubs, eq(clubs.id, clubTables.clubId)).where(eq(clubTables.id, session.targetId)).limit(1);
  if (!row) throw new AppError('tv.table_not_found', 404);
  const { table } = row;
  const [room] = table.roomId
    ? await ctx.db.select({ name: clubRooms.name }).from(clubRooms).where(eq(clubRooms.id, table.roomId)).limit(1)
    : [];
  const hand = await currentHand(ctx.db, { tableId: table.id });
  return {
    table: {
      name: table.name,
      status: table.status,
      clubName: row.clubName,
      roomName: room?.name ?? null,
      joinCode: table.joinCode,
      joinUrl: table.joinCode ? `${ctx.config.publicAppUrl}/#/join/${table.joinCode}` : null,
    },
    hand: hand ? await tvHand(ctx.db, hand) : null,
    markets: hand ? await popularMarkets(ctx.db, hand.id) : [],
    recent: await recentFlops(ctx.db, table.id),
    bettingTimerSeconds: ctx.config.bettingTimerSeconds || null,
    serverNow: ctx.now(),
    expiresAt: session.expiresAt,
  };
}
