import type { ModuleRegistrar } from '../index.js';

/**
 * Inspector module. Add routes inside the registrar; register hooks, funds, jobs
 * and socket extensions at the top level of this file (runs once).
 */
export const registerInspector: ModuleRegistrar = (_api, _ctx) => {};
