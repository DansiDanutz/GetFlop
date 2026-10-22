import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { arenaPlayers, memberships } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { arenaConfig, type ArenaConfig } from './config.js';
import { ensureArena } from './setup.js';
import { moveStars, starBalance, starWallet } from './stars.js';

export type ArenaPlayer = typeof arenaPlayers.$inferSelect;

export interface RefillInfo {
  /** A refill is offered below this balance. */
  readonly underCents: number;
  /** The balance a refill brings you back to. */
  readonly targetCents: number;
  /** What a refill would add now (or the full target while above the floor). */
  readonly amountCents: number;
  readonly ready: boolean;
  /** When the next refill may be taken, while waiting for the 24 h to pass. */
  readonly nextAt: string | null;
}

/** Free refill state: under 500 ★ → back to 2,000 ★, at most once every 24 h. */
export function refillInfo(balanceCents: number, lastRefillAt: Date | null, now: Date, cfg: ArenaConfig): RefillInfo {
  const below = balanceCents < cfg.refillUnderCents;
  const allowedAt = lastRefillAt ? new Date(lastRefillAt.getTime() + cfg.refillEveryMs) : null;
  const waiting = Boolean(allowedAt && allowedAt > now);
  return {
    underCents: cfg.refillUnderCents,
    targetCents: cfg.refillTargetCents,
    amountCents: below ? cfg.refillTargetCents - balanceCents : cfg.refillTargetCents,
    ready: below && !waiting,
    nextAt: waiting ? allowedAt!.toISOString() : null,
  };
}

export async function findPlayer(db: DbOrTx, userId: string): Promise<ArenaPlayer | null> {
  const [row] = await db.select().from(arenaPlayers).where(eq(arenaPlayers.userId, userId)).limit(1);
  return row ?? null;
}

export function assertOpen(cfg: ArenaConfig = arenaConfig()): void {
  if (!cfg.open) throw new AppError('arena.closed', 409);
}

export type EnterKind = 'welcome' | 'refill' | null;

export interface EnterResult {
  readonly entered: true;
  readonly kind: EnterKind;
  readonly grantedCents: number;
  readonly balanceCents: number;
  readonly refill: RefillInfo;
}

async function joinArena(ctx: AppContext, tx: DbOrTx, clubId: string, userId: string): Promise<void> {
  const now = ctx.now();
  await tx.insert(arenaPlayers).values({ userId, joinedAt: now, lastSeenAt: null });
  await tx.insert(memberships).values({
    clubId, userId, roles: [], status: 'active', playMode: 'play', via: 'arena', reviewedAt: now, termsAcceptedAt: now,
  }).onConflictDoUpdate({ target: [memberships.clubId, memberships.userId], set: { status: 'active', playMode: 'play', roles: [] } });
}

/** First entry: membership, wallet and the welcome grant. Later: claims a due free refill. */
export async function enterArena(ctx: AppContext, userId: string): Promise<EnterResult> {
  const cfg = arenaConfig();
  assertOpen(cfg);
  const { clubId } = await ensureArena(ctx);
  const now = ctx.now();
  let result: { kind: EnterKind; granted: number };
  try {
    result = await ctx.db.transaction(async (tx) => {
      const player = await findPlayer(tx, userId);
      if (!player) {
        await joinArena(ctx, tx, clubId, userId);
        await moveStars(tx, { kind: 'welcome', from: null, to: starWallet(userId), amountCents: cfg.welcomeCents, userId });
        return { kind: 'welcome' as const, granted: cfg.welcomeCents };
      }
      const info = refillInfo(await starBalance(tx, userId), player.lastRefillAt, now, cfg);
      if (!info.ready) return { kind: null, granted: 0 };
      await moveStars(tx, { kind: 'refill', from: null, to: starWallet(userId), amountCents: info.amountCents, userId });
      await tx.update(arenaPlayers).set({ lastRefillAt: now }).where(eq(arenaPlayers.userId, userId));
      return { kind: 'refill' as const, granted: info.amountCents };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    ctx.logger.error('Arena enter failed', err);
    throw new AppError('arena.enter_failed', 500);
  }
  const balanceCents = await starBalance(ctx.db, userId);
  if (result.granted > 0) ctx.events.emit(rooms.user(userId), 'balance:updated', { clubId, balanceCents, unit: 'stars' });
  const player = await findPlayer(ctx.db, userId);
  return {
    entered: true, kind: result.kind, grantedCents: result.granted, balanceCents,
    refill: refillInfo(balanceCents, player?.lastRefillAt ?? null, now, cfg),
  };
}

/** Marks the player as sitting at a table (keeps it awake). */
export async function touchPresence(ctx: AppContext, userId: string, tableId: string): Promise<void> {
  await ctx.db.update(arenaPlayers).set({ lastSeenAt: ctx.now(), lastTableId: tableId }).where(eq(arenaPlayers.userId, userId));
}

export async function requirePlayer(db: DbOrTx, userId: string): Promise<ArenaPlayer> {
  const player = await findPlayer(db, userId);
  if (!player) throw new AppError('arena.enter_failed', 409);
  return player;
}
