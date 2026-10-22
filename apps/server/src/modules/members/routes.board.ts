import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { loadClubAccess } from '../clubs/access.js';
import { clubBar, clubBoard, setBoardHidden } from './board.js';
import { clubMedals } from './medals.js';
import { markSeen, onboardingState, SCENARIOS } from './onboarding.js';

/** Club board, place bar, medals (03 §11) and onboarding progress. */
export function registerBoardRoutes(api: Router, ctx: AppContext): void {
  const access = (req: { params: Record<string, unknown> } & Parameters<typeof currentUser>[0]) =>
    loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId));

  api.get('/clubs/onboarding', handle(async (req) => onboardingState(ctx, currentUser(req))));

  api.post('/clubs/onboarding/seen', handle(async (req) => {
    const { code, scenario } = z.object({ code: z.string().min(1).max(60), scenario: z.enum(SCENARIOS) }).parse(req.body);
    await markSeen(ctx, currentUser(req).id, scenario, code);
    return { seen: true };
  }));

  api.get('/clubs/:clubId/board', handle(async (req) => {
    const q = z.object({
      period: z.enum(['week', 'month']).default('week'), metric: z.enum(['net', 'flops']).default('net'), tz: z.string().max(64).optional(),
    }).parse(req.query);
    return clubBoard(ctx, await access(req), q);
  }));

  api.post('/clubs/:clubId/board/hidden', handle(async (req) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    return setBoardHidden(ctx, await access(req), hidden);
  }));

  api.get('/clubs/:clubId/bar', handle(async (req) => {
    const { tz } = z.object({ tz: z.string().max(64).optional() }).parse(req.query);
    return clubBar(ctx, await access(req), tz);
  }));

  api.get('/clubs/:clubId/medals', handle(async (req) => clubMedals(ctx, await access(req))));
}
