import type { Request, Response } from 'express';
import { z } from 'zod';
import type { TvKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import type { ModuleRegistrar } from '../index.js';
import { addSocketExtension } from '../jobs.js';
import { cashDisplay } from './cashDisplay.js';
import { CLAIM_MAX_FAILURES, CLAIM_WINDOW_MS } from './constants.js';
import { createRateLimiter } from './rateLimit.js';
import {
  claimPairing, createDirectSession, createPairing, findSession, listSessions, requireDisplay, revokeSession,
} from './service.js';
import { tvSocketExtension } from './socket.js';
import { resolveTarget, TV_CAPABILITY } from './targets.js';
import { tournamentDisplay } from './tournamentDisplay.js';

addSocketExtension(tvSocketExtension);

const id = z.string().min(1).max(100);
const tableBody = z.object({ tableId: id });
const tournamentBody = z.object({ tournamentId: id });
const claimBody = z.object({ code: z.unknown() });
const sessionsQuery = z.object({ kind: z.enum(['cash', 'tournament']), targetId: id });

const targetIdOf = (kind: TvKind, body: unknown): string =>
  kind === 'cash' ? tableBody.parse(body).tableId : tournamentBody.parse(body).tournamentId;

const NO_STORE = (res: Response): void => { res.setHeader('Cache-Control', 'no-store'); };

/**
 * Room TV. Staff endpoints (signed in): pairings, direct-link sessions, list and revoke.
 * Public endpoints (display token only): claim a code, read the display payload.
 */
export const registerTv: ModuleRegistrar = (api, ctx) => {
  const claimLimiter = createRateLimiter({ max: CLAIM_MAX_FAILURES, windowMs: CLAIM_WINDOW_MS });

  const launch = (kind: TvKind, forLaunch = true) => async (req: Request) => {
    const user = currentUser(req);
    const target = await resolveTarget(ctx, req, user, kind, targetIdOf(kind, req.body), { forLaunch });
    return { user, target };
  };

  for (const kind of ['cash', 'tournament'] as const) {
    api.post(`/tv/${kind}-pairings`, handle(async (req) => {
      const { user, target } = await launch(kind)(req);
      return createPairing(ctx, target, user.id);
    }));

    api.post(`/tv/${kind}-sessions`, handle(async (req) => {
      const { user, target } = await launch(kind)(req);
      return createDirectSession(ctx, target, user.id);
    }));

    api.post(`/tv/${kind}-pairings/claim`, handle(async (req) => {
      const { code } = claimBody.parse(req.body ?? {});
      const key = req.ip ?? 'unknown';
      const nowMs = ctx.now().getTime();
      if (claimLimiter.isLimited(key, nowMs)) throw new AppError('tv.pairing_rate_limited', 429);
      const result = await claimPairing(ctx, kind, code);
      if (!result.ok) {
        claimLimiter.hit(key, nowMs);
        throw new AppError(result.code, result.code === 'tv.pairing_expired' ? 410 : 400);
      }
      const nameKey = kind === 'cash' ? 'tableName' : 'tournamentName';
      return { displayToken: result.displayToken, [nameKey]: result.name, expiresAt: result.expiresAt };
    }));
  }

  api.get('/tv/sessions', handle(async (req) => {
    const { kind, targetId } = sessionsQuery.parse(req.query);
    const target = await resolveTarget(ctx, req, currentUser(req), kind, targetId, { forLaunch: false });
    return { sessions: await listSessions(ctx, target) };
  }));

  api.delete('/tv/sessions/:id', handle(async (req) => {
    const user = currentUser(req);
    const session = await findSession(ctx, id.parse(req.params.id));
    await requireClub(ctx.db, req, user, TV_CAPABILITY[session.kind], session.clubId);
    await revokeSession(ctx, session);
    return { revoked: true };
  }));

  api.get('/tv/cash/:token', handle(async (req, res) => {
    NO_STORE(res);
    return cashDisplay(ctx, await requireDisplay(ctx, String(req.params.token), 'cash'));
  }));

  api.get('/tv/tournament/:token', handle(async (req, res) => {
    NO_STORE(res);
    return tournamentDisplay(ctx, await requireDisplay(ctx, String(req.params.token), 'tournament'));
  }));
};
