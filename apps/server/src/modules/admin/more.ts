import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { listAudit } from './audit.js';
import { listBetTypes } from './betTypes.js';
import { reconciliation } from './financials.js';
import { listHands } from './play.js';

/** The admin "More" menu, in display order. */
export const MORE_SECTIONS = [
  { key: 'hands', endpoint: '/admin/hands' },
  { key: 'reconciliation', endpoint: '/admin/financials/reconciliation' },
  { key: 'audit', endpoint: '/admin/audit' },
  { key: 'bettypes', endpoint: '/admin/bet-types' },
  { key: 'arena', endpoint: '/admin/platform/arena' },
  { key: 'appqr', endpoint: null },
] as const;

export type MoreKey = (typeof MORE_SECTIONS)[number]['key'];

const LOADERS: Record<MoreKey, (ctx: AppContext) => Promise<unknown>> = {
  hands: (ctx) => listHands(ctx, {}),
  reconciliation: (ctx) => reconciliation(ctx),
  audit: (ctx) => listAudit(ctx, { page: 1, limit: 50 }),
  bettypes: (ctx) => listBetTypes(ctx),
  // The Arena report is served by the Arena module.
  arena: async () => ({ endpoint: '/admin/platform/arena' }),
  appqr: async (ctx) => ({ url: ctx.config.publicAppUrl }),
};

export function moreSections() {
  return { sections: MORE_SECTIONS.map((s) => ({ ...s })) };
}

export async function moreSection(ctx: AppContext, key: string) {
  const section = MORE_SECTIONS.find((s) => s.key === key);
  if (!section) throw new AppError('admin.section_not_found', 404);
  return { key: section.key, endpoint: section.endpoint, data: await LOADERS[section.key](ctx) };
}
