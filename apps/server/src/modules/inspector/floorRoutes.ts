import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import { simStep, simulationOverview } from './autodeal.js';
import { dashboard } from './dashboard.js';
import { dealersList, deletePreview, deleteTable, regenerateJoinCode, setLobbyCard, tableInfo } from './tablesAdmin.js';

const lobbyCardBody = z.object({
  game: z.string(),
  featured: z.boolean(),
  photo: z.string().max(600_000).nullable().optional(),
});

/** Floor: dashboard, table extras, dealers, simulation. */
export function registerFloorRoutes(api: Router, ctx: AppContext): void {
  api.get('/inspector/dashboard', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return dashboard(ctx, access);
  }));

  api.get('/inspector/dealers', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return { dealers: await dealersList(ctx, access) };
  }));

  api.get('/inspector/table/:id/delete-preview', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return deletePreview(ctx, access, String(req.params.id));
  }));

  api.delete('/inspector/table/:id', handle(async (req) => {
    const { expectMode } = z.object({ expectMode: z.enum(['delete', 'archive']).optional() }).parse({ ...req.query, ...(req.body ?? {}) });
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return deleteTable(ctx, access, String(req.params.id), expectMode);
  }));

  api.put('/inspector/table/:id/lobby-card', handle(async (req) => {
    const body = lobbyCardBody.parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const table = await setLobbyCard(ctx, access, String(req.params.id), body);
    return { table: { id: table.id, game: table.game, featured: table.featured, photoUrl: table.photoUrl } };
  }));

  api.post('/tables/:id/generate-code', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return { joinCode: await regenerateJoinCode(ctx, access, String(req.params.id)) };
  }));

  api.get('/tables/:code/info', handle(async (req) => tableInfo(ctx, String(req.params.code))));

  api.get('/inspector/simulation', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return simulationOverview(ctx, access);
  }));

  api.post('/player/table/:id/sim-step', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return simStep(ctx, access, String(req.params.id));
  }));
}
