import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import type { bets, clubTables, coupons, hands } from '../../db/schema/index.js';

export type HandRow = typeof hands.$inferSelect;
export type BetRow = typeof bets.$inferSelect;
export type CouponRow = typeof coupons.$inferSelect;
export type TableRowT = typeof clubTables.$inferSelect;

export interface SettledInfo {
  readonly table: TableRowT;
  readonly hand: HandRow;
  readonly bets: readonly BetRow[];
  readonly matchingSlugs: readonly string[];
}

/** Code other modules run inside the settlement transaction (play charge, tournaments, arena badges …). */
export type SettledHook = (ctx: AppContext, tx: Tx, info: SettledInfo) => Promise<void>;
/** Runs after the transaction commits (notifications, auto-deal scheduling). */
export type AfterHook = (ctx: AppContext, info: SettledInfo) => void | Promise<void>;
/** Before a coupon is accepted: throw an AppError to refuse (tournament rules, billing pauses …). */
export type CouponGuard = (ctx: AppContext, tx: Tx, input: { table: TableRowT; userId: string; commitment: number; rounds: number }) => Promise<void>;
/** Before a hand starts: throw to refuse (billing pause, tournament not running …). */
export type StartGuard = (ctx: AppContext, tx: Tx, table: TableRowT) => Promise<void>;

export const hooks = {
  settled: [] as SettledHook[],
  afterSettled: [] as AfterHook[],
  couponGuards: [] as CouponGuard[],
  startGuards: [] as StartGuard[],
};
