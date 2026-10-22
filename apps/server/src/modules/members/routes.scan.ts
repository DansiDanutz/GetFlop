import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { loadClubAccess } from '../clubs/access.js';
import { issuePlayerCode, secondsUntilRotation } from './playerCode.js';
import { scanCode, scanRequest } from './scan.js';

const codeBody = z.object({ code: z.string().min(1).max(500), confirmReturn: z.boolean().optional() });

/** Rotating player code ("My code") and the desk scan (03 §6). */
export function registerScanRoutes(api: Router, ctx: AppContext): void {
  api.get('/clubs/player-code', handle((req) => {
    const now = ctx.now();
    return { code: issuePlayerCode(currentUser(req).id, now), rotatesInSeconds: secondsUntilRotation(now) };
  }));

  api.post('/clubs/:clubId/scan', handle(async (req) => {
    const { code } = codeBody.parse(req.body);
    return scanCode(ctx, await loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId)), code);
  }));

  api.post('/clubs/:clubId/scan/request', handle(async (req) => {
    const { code, confirmReturn } = codeBody.parse(req.body);
    return scanRequest(ctx, await loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId)), code, Boolean(confirmReturn));
  }));
}
