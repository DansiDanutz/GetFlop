import { and, countDistinct, count, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { bets, clubTables, hands } from '../../db/schema/index.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import { unitForTable } from '../game/coupons.js';
import { heldTable, standUp } from '../game/dealer.js';
import { cancelHand, enterFlop, noMoreBets, publicHand, startHand } from '../game/hands.js';
import { tableView } from '../game/routes.js';
import { getTable, liveHand, type TableRow } from '../game/tables.js';
import type { ModuleRegistrar } from '../index.js';
import { markNoticeRead, unreadNotices } from './notices.js';
import { SCAN_MEDIA_TYPES, scanFlop } from './scan.js';
import { leaveHeld, needsApproval, sitOrAsk, switchTable, type SitResult } from './seating.js';
import { cancelSitRequest, pendingRequestOf, reviewSitRequest } from './sitRequests.js';

const MAX_HANDS = 50;
const DEFAULT_HANDS = 20;
/** Base64 of a downscaled JPEG (≤1568 px) stays well below this. */
const MAX_IMAGE_BASE64 = 1_900_000;

const handsQuery = z.object({ limit: z.coerce.number().int().min(1).max(MAX_HANDS).default(DEFAULT_HANDS) });
const flopBody = z.object({ card1: z.string(), card2: z.string(), card3: z.string() });
const switchBody = z.object({ heldTableId: z.string().min(1) });
const scanBody = z.object({
  image: z.string().min(1).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mediaType: z.enum(SCAN_MEDIA_TYPES as [string, ...string[]]),
});

/** Tournament tables carry a flag for the table list: "starts soon" before the first hand, then "live". */
function tournamentFlag(table: TableRow, hasHand: boolean): 'soon' | 'live' | null {
  if (table.kind !== 'tournament') return null;
  return hasHand || table.lastHandNumber > 0 ? 'live' : 'soon';
}

async function dealerTableView(ctx: AppContext, table: TableRow) {
  const view = await tableView(ctx, table);
  return { ...view, tournament: tournamentFlag(table, Boolean(view.currentHand)) };
}

async function liveCounts(ctx: AppContext, handId: string | null) {
  if (!handId) return { players: 0, picks: 0 };
  const [row] = await ctx.db.select({ picks: count(), players: countDistinct(bets.userId) }).from(bets)
    .where(and(eq(bets.handId, handId), ne(bets.status, 'refunded')));
  return { players: row?.players ?? 0, picks: row?.picks ?? 0 };
}

async function sitResponse(ctx: AppContext, out: SitResult) {
  return out.status === 'seated' ? { status: out.status, table: await dealerTableView(ctx, out.table) } : out;
}

function registerSeating(api: Router, ctx: AppContext): void {
  api.get('/dealer/tables', handle(async (req) => {
    const held = await heldTable(ctx.db, currentUser(req).id);
    return { tables: held ? [{ ...(await dealerTableView(ctx, held.table)), clubName: held.clubName }] : [] };
  }));

  api.get('/dealer/available-tables', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'deal');
    const open = await ctx.db.select().from(clubTables).where(and(
      eq(clubTables.clubId, access.club.id), eq(clubTables.status, 'open'), isNull(clubTables.dealerId), eq(clubTables.isAutoDeal, false),
    )).orderBy(clubTables.createdAt);
    return {
      tables: await Promise.all(open.map((t) => dealerTableView(ctx, t))),
      needsApproval: needsApproval(access),
      pending: await pendingRequestOf(ctx.db, user.id),
    };
  }));

  api.post('/dealer/table/:id/sit', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'deal');
    return sitResponse(ctx, await sitOrAsk(ctx, access, String(req.params.id)));
  }));

  api.post('/dealer/table/:id/switch', handle(async (req) => {
    const { heldTableId } = switchBody.parse(req.body ?? {});
    const access = await requireClub(ctx.db, req, currentUser(req), 'deal');
    return sitResponse(ctx, await switchTable(ctx, access, String(req.params.id), heldTableId));
  }));

  api.post('/dealer/table/:id/leave', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'deal');
    return { table: await dealerTableView(ctx, await standUp(ctx, access.club.id, String(req.params.id), user.id, 'self')) };
  }));

  api.post('/dealer/held/leave', handle(async (req) => leaveHeld(ctx, currentUser(req).id)));

  api.post('/dealer/sit-requests/:id/cancel', handle(async (req) =>
    ({ request: await cancelSitRequest(ctx, currentUser(req).id, String(req.params.id)) })));

  api.get('/dealer/notices', handle(async (req) => ({ notices: await unreadNotices(ctx.db, currentUser(req).id) })));

  api.post('/dealer/notices/:id/read', handle(async (req) =>
    ({ read: await markNoticeRead(ctx, currentUser(req).id, String(req.params.id)) })));
}

function registerConsole(api: Router, ctx: AppContext): void {
  const dealerAction = (fn: (clubId: string, tableId: string, userId: string, req: Parameters<Parameters<typeof handle>[0]>[0]) => Promise<unknown>) =>
    handle(async (req) => {
      const user = currentUser(req);
      const access = await requireClub(ctx.db, req, user, 'deal');
      return fn(access.club.id, String(req.params.id), user.id, req);
    });

  api.get('/dealer/table/:id/current-hand', dealerAction(async (clubId, tableId) => {
    const table = await getTable(ctx.db, clubId, tableId);
    const view = await dealerTableView(ctx, table);
    const hand = await liveHand(ctx.db, tableId);
    return { table: view, hand: view.currentHand, live: await liveCounts(ctx, hand?.id ?? null) };
  }));

  api.get('/dealer/table/:id/hands', dealerAction(async (clubId, tableId, _userId, req) => {
    const { limit } = handsQuery.parse(req.query);
    const table = await getTable(ctx.db, clubId, tableId);
    const rows = await ctx.db.select().from(hands).where(eq(hands.tableId, tableId)).orderBy(desc(hands.handNumber)).limit(limit);
    return { hands: rows.map(publicHand), unit: unitForTable(table.kind) };
  }));

  api.post('/dealer/table/:id/start-hand', dealerAction(async (clubId, tableId, userId) => {
    const { hand, bettingTimerSeconds } = await startHand(ctx, clubId, tableId, { userId });
    return { hand: publicHand(hand), bettingTimerSeconds };
  }));

  api.post('/dealer/table/:id/no-more-bets', dealerAction(async (clubId, tableId, userId) =>
    ({ hand: publicHand(await noMoreBets(ctx, clubId, tableId, { userId })) })));

  api.post('/dealer/table/:id/enter-flop', dealerAction(async (clubId, tableId, userId, req) => {
    const { card1, card2, card3 } = flopBody.parse(req.body);
    const info = await enterFlop(ctx, clubId, tableId, { userId }, [card1, card2, card3]);
    return { hand: publicHand(info.hand), matchingSlugs: info.matchingSlugs };
  }));

  api.post('/dealer/table/:id/cancel-hand', dealerAction(async (clubId, tableId, userId) =>
    ({ hand: publicHand(await cancelHand(ctx, clubId, tableId, { userId })) })));

  api.post('/dealer/table/:id/scan-flop', dealerAction(async (clubId, tableId, userId, req) => {
    const body = scanBody.parse(req.body ?? {});
    const image = Buffer.from(body.image, 'base64');
    return scanFlop(ctx, clubId, tableId, userId, { image, mediaType: body.mediaType as (typeof SCAN_MEDIA_TYPES)[number] });
  }));
}

function registerStaff(api: Router, ctx: AppContext): void {
  api.post('/inspector/dealer-sit/:id/:decision', handle(async (req) => {
    const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
    const access = await requireClub(ctx.db, req, currentUser(req), 'requests.review');
    return reviewSitRequest(ctx, access, String(req.params.id), decision);
  }));
  // The club's dealer-sit-approval setting itself (GET/PUT /clubs/:clubId/dealer-sit-approval) lives in the members module.
}

/**
 * Dealer module: seating (sit / ask / switch / stand up), sit requests and their floor review,
 * dealer notices, the console's hand controls and the flop scan.
 */
export const registerDealer: ModuleRegistrar = (api, ctx) => {
  registerSeating(api, ctx);
  registerConsole(api, ctx);
  registerStaff(api, ctx);
};
