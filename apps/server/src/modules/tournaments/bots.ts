/**
 * Simulation bots for test events (botsAllowed): they enter for free and, on auto-dealt
 * tables, place one random pick per hand. Their failures go to the event log (telemetry).
 */
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { memberships, tournamentEntries, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { hashSecret } from '../auth/crypto.js';
import { loadClubAccess } from '../clubs/access.js';
import { placeCoupon } from '../game/coupons.js';
import { activeSlugs } from '../game/markets.js';
import { nextPlayableHand } from './chips.js';
import { levelForHand } from './rules.js';
import { entriesOf, logEvent, type TournamentRow } from './store.js';

export const DEFAULT_BOT_COUNT = 4;
/** Chance a bot plays a given hand. */
export const BOT_PLAY_CHANCE = 0.8;
const BOT_ID_CHARS = 6;

async function clubBots(tx: Tx, clubId: string): Promise<string[]> {
  const rows = await tx.select({ id: users.id }).from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'), eq(users.isBot, true)));
  return rows.map((r) => r.id);
}

async function createBot(ctx: AppContext, tx: Tx, clubId: string, n: number): Promise<string> {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, BOT_ID_CHARS);
  const [user] = await tx.insert(users).values({
    username: `bot_${suffix}`, displayName: `Bot ${n}`, pinHash: await hashSecret(crypto.randomUUID()),
    isBot: true, termsAcceptedAt: ctx.now(),
  }).returning({ id: users.id });
  await tx.insert(memberships).values({ clubId, userId: user!.id, status: 'active', via: 'created', termsAcceptedAt: ctx.now() });
  return user!.id;
}

/** Makes sure the club has bots and enters every one of them (free). */
export async function ensureBots(ctx: AppContext, tx: Tx, t: TournamentRow): Promise<number> {
  const bots = await clubBots(tx, t.clubId);
  for (let n = bots.length + 1; n <= DEFAULT_BOT_COUNT; n += 1) bots.push(await createBot(ctx, tx, t.clubId, n));
  for (const userId of bots) {
    await tx.insert(tournamentEntries).values({
      tournamentId: t.id, clubId: t.clubId, userId, isBot: true, status: 'registered', registeredAt: ctx.now(),
    }).onConflictDoNothing();
  }
  await logEvent(tx, t.id, 'bots_entered', { count: bots.length });
  return bots.length;
}

/** Each bot still in plays one random market at the level minimum (all-in when short). */
export async function botsPlay(ctx: AppContext, t: TournamentRow, rng: () => number = Math.random): Promise<number> {
  const bots = (await entriesOf(ctx.db, t.id)).filter((e) => e.isBot && e.status === 'active' && e.chips > 0);
  if (bots.length === 0) return 0;
  const menu = t.markets.length > 0 ? t.markets : await activeSlugs(ctx.db);
  const level = levelForHand(t.levels, await nextPlayableHand(ctx.db, t));
  let placed = 0;
  for (const bot of bots) {
    if (rng() >= BOT_PLAY_CHANCE) continue;
    const market = menu[Math.floor(rng() * menu.length)]!;
    const stakeCents = bot.chips < level.minBetChips ? bot.chips : level.minBetChips;
    const [user] = await ctx.db.select().from(users).where(eq(users.id, bot.userId));
    try {
      const access = await loadClubAccess(ctx.db, user!, t.clubId);
      await placeCoupon(ctx, access, { tableId: t.tableId, selections: [{ market, stakeCents }], rounds: 1 });
      placed += 1;
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'server.error';
      await logEvent(ctx.db, t.id, 'bot_pick_failed', { bot: user?.username, market, stakeCents, code }, err instanceof AppError ? 'warning' : 'error');
    }
  }
  return placed;
}
