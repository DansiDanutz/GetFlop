import { Router } from 'express';
import type { AppContext } from '../context.js';
import { registerAdmin } from './admin/register.js';
import { registerArena } from './arena/register.js';
import { authRouter } from './auth/routes.js';
import { clubsRouter } from './clubs/routes.js';
import { registerCommerce } from './commerce/register.js';
import { registerDealer } from './dealer/register.js';
import { registerGame } from './game/routes.js';
import { registerInspector } from './inspector/register.js';
import { registerMembers } from './members/register.js';
import { registerMessages } from './messages/register.js';
import { registerPlayer } from './player/register.js';
import { registerPoints } from './points/routes.js';
import { registerTournaments } from './tournaments/register.js';
import { registerTv } from './tv/register.js';

/** A module adds its routes to the /api router (it may use several path prefixes). */
export type ModuleRegistrar = (api: Router, ctx: AppContext) => void;

/**
 * Every module, in mount order. More specific paths must come before generic
 * ones that could shadow them (e.g. /clubs/:id/... before the clubs router).
 */
const MODULES: ModuleRegistrar[] = [
  (api, ctx) => api.use('/auth', authRouter(ctx)),
  registerPoints,
  registerGame,
  registerDealer,
  registerPlayer,
  registerInspector,
  registerMembers,
  registerMessages,
  registerTv,
  registerTournaments,
  registerArena,
  registerCommerce,
  registerAdmin,
  (api, ctx) => api.use('/clubs', clubsRouter(ctx)),
];

export function apiRouter(ctx: AppContext): Router {
  const api = Router();
  for (const register of MODULES) register(api, ctx);
  return api;
}
