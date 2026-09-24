import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import { balanceOf, stock, supply, walletDrift, wallet } from './ledger.js';
import {
  createPlayerRequest, listRequests, mint, moveStock, parseAmount, reviewPlayerRequest, staffTransfer,
} from './service.js';

const amountBody = z.object({ amount: z.union([z.string(), z.number()]).optional(), amountCents: z.number().int().optional(), note: z.string().optional() });
const centsFrom = (body: z.infer<typeof amountBody>): number =>
  body.amountCents !== undefined ? parseAmount((body.amountCents / 100).toFixed(2)) : parseAmount(body.amount);

export function registerPoints(api: Router, ctx: AppContext): void {
  api.get('/clubs/:clubId/points', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'stock.manage', String(req.params.clubId));
    return supply(ctx.db, access.club.id);
  }));

  api.post('/clubs/:clubId/points/mint', handle(async (req) => {
    const body = z.object({ amount: z.union([z.string(), z.number()]), reason: z.string().optional() }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view', String(req.params.clubId));
    await mint(ctx, access, parseAmount(body.amount), body.reason);
    return supply(ctx.db, access.club.id);
  }));

  api.post('/inspector/player/:userId/:direction', handle(async (req) => {
    const direction = z.enum(['load', 'withdraw']).parse(req.params.direction);
    const body = amountBody.parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const balanceCents = await staffTransfer(ctx, access, String(req.params.userId), direction, centsFrom(body), body.note);
    return { balanceCents };
  }));

  api.post('/clubs/:clubId/members/:userId/stock', handle(async (req) => {
    const body = amountBody.extend({ direction: z.enum(['give', 'take']) }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view', String(req.params.clubId));
    const stockCents = await moveStock(ctx, access, String(req.params.userId), body.direction, centsFrom(body), body.note);
    return { stockCents };
  }));

  api.post('/player/reload-request', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const row = await createPlayerRequest(ctx, access, 'load', centsFrom(amountBody.parse(req.body)));
    return { request: row };
  }));

  api.post('/player/cashout-request', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const row = await createPlayerRequest(ctx, access, 'cashout', centsFrom(amountBody.parse(req.body)));
    return { request: row };
  }));

  api.get('/player/requests', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'view');
    const rows = await listRequests(ctx, access.club.id, { userId: user.id, sinceDays: 30 });
    return { reloads: rows.filter((r) => r.kind === 'load'), cashouts: rows.filter((r) => r.kind === 'cashout') };
  }));

  api.get('/player/balance', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'view');
    return { clubId: access.club.id, balanceCents: await balanceOf(ctx.db, access.club.id, wallet(user.id)) };
  }));

  api.get('/inspector/requests', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'requests.review');
    const rows = await listRequests(ctx, access.club.id, { status: ['pending'] });
    return {
      reloads: rows.filter((r) => r.kind === 'load'),
      cashouts: rows.filter((r) => r.kind === 'cashout'),
      myStock: access.rank >= 3 ? null : await balanceOf(ctx.db, access.club.id, stock(user.id)),
    };
  }));

  api.get('/inspector/requests/history', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'requests.review');
    const days = Math.min(Number(req.query.days ?? 30) || 30, 90);
    return { items: await listRequests(ctx, access.club.id, { status: ['approved', 'rejected'], sinceDays: days }) };
  }));

  api.post('/inspector/request/:id/:decision', handle(async (req) => {
    const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return { request: await reviewPlayerRequest(ctx, access, String(req.params.id), decision, reason) };
  }));

  api.get('/inspector/wallet-drift', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return walletDrift(ctx.db, access.club.id);
  }));
}
