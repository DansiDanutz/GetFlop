import type { ModuleRegistrar } from '../index.js';

/**
 * Tournaments module. Add routes inside the registrar; register hooks, funds, jobs
 * and socket extensions at the top level of this file (runs once).
 */
export const registerTournaments: ModuleRegistrar = (_api, _ctx) => {};
