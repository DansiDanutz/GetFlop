import { Router } from 'express';
import type { AppContext } from '../context.js';
import { authRouter } from './auth/routes.js';
import { clubsRouter } from './clubs/routes.js';
import { registerGame } from './game/routes.js';
import { registerPoints } from './points/routes.js';

/** A module adds its routes to the /api router (it may use several path prefixes). */
export type ModuleRegistrar = (api: Router, ctx: AppContext) => void;

/** Every module, in mount order. Add new modules here. */
const MODULES: ModuleRegistrar[] = [
  (api, ctx) => api.use('/auth', authRouter(ctx)),
  registerPoints,
  registerGame,
  (api, ctx) => api.use('/clubs', clubsRouter(ctx)),
];

export function apiRouter(ctx: AppContext): Router {
  const api = Router();
  for (const register of MODULES) register(api, ctx);
  return api;
}
