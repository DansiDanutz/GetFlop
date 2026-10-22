import type { AppContext } from '../../context.js';
import { weekRank } from './board.js';
import { arenaConfig, dealSeconds } from './config.js';
import { findPlayer, refillInfo } from './players.js';
import { ensureArena } from './setup.js';
import { starBalance } from './stars.js';
import { weekKey } from './time.js';

/** GET /arena/summary: the home tile and lobby header. */
export async function summary(ctx: AppContext, userId: string) {
  const cfg = arenaConfig();
  const now = ctx.now();
  if (!cfg.open) return { open: false, entered: false, stars: 0, balanceCents: 0 };
  const { clubId, tableId } = await ensureArena(ctx);
  const player = await findPlayer(ctx.db, userId);
  const balanceCents = await starBalance(ctx.db, userId);
  return {
    open: true, entered: Boolean(player), clubId, tableId, balanceCents, stars: balanceCents,
    dealSeconds: dealSeconds(cfg), shopOpen: cfg.shopOpen,
    refill: refillInfo(balanceCents, player?.lastRefillAt ?? null, now, cfg),
    totalFlops: player?.totalFlops ?? 0,
  };
}

/** GET /arena/bar: the place-and-balance bar on the Arena table. */
export async function bar(ctx: AppContext, userId: string) {
  const cfg = arenaConfig();
  const now = ctx.now();
  const player = await findPlayer(ctx.db, userId);
  const balanceCents = await starBalance(ctx.db, userId);
  return {
    rank: await weekRank(ctx, userId),
    weekOf: weekKey(now, cfg.timeZone),
    balanceCents,
    hidden: player?.boardHidden ?? false,
    refill: {
      ...refillInfo(balanceCents, player?.lastRefillAt ?? null, now, cfg),
      under: cfg.refillUnderCents, amount: cfg.refillTargetCents,
    },
    shop: { open: cfg.shopOpen },
  };
}
