import type { ModuleRegistrar } from '../index.js';

/**
 * Dealer module. Add routes inside the registrar; register hooks, funds, jobs
 * and socket extensions at the top level of this file (runs once).
 */
export const registerDealer: ModuleRegistrar = (_api, _ctx) => {};
