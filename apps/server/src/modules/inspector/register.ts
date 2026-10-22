import type { ModuleRegistrar } from '../index.js';
import { addJob } from '../jobs.js';
import { autoDealTick } from './autodeal.js';
import { checkBudget } from './budget.js';
import { registerFloorRoutes } from './floorRoutes.js';
import { registerReportRoutes } from './reportRoutes.js';
import { autoCloseSessions } from './sessions.js';

// Background jobs (registered once, at module load).
addJob({ name: 'inspector-auto-deal', everyMs: 1_000, run: autoDealTick });
addJob({ name: 'inspector-sim-budget', everyMs: 60_000, run: (ctx) => checkBudget(ctx) });
addJob({ name: 'inspector-session-cutoff', everyMs: 60_000, run: autoCloseSessions });

/** Inspector module: the floor, table extras, reports, sessions and simulation. */
export const registerInspector: ModuleRegistrar = (api, ctx) => {
  registerFloorRoutes(api, ctx);
  registerReportRoutes(api, ctx);
};
