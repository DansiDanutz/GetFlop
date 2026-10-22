import { and, eq, gt } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { messageSuggestionDismissals } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { audienceMembers } from './audiences.js';
import { SUGGESTION_SNOOZE_MS, type AudienceKey } from './constants.js';
import { openTables, tournamentTargets } from './targets.js';

export type SuggestionKind = 'comeback' | 'welcome' | 'tournament' | 'table';

export interface Suggestion {
  readonly key: string;
  readonly kind: SuggestionKind;
  readonly audience: AudienceKey;
  readonly params: Readonly<Record<string, string | number | null>>;
  readonly action?: { readonly type: 'table' | 'tournament'; readonly ref: string; readonly label: string };
}

/** Upcoming tournaments suggested at once (the soonest first). */
const MAX_TOURNAMENT_SUGGESTIONS = 2;

async function candidates(ctx: AppContext, access: ClubAccess, tz: string): Promise<Suggestion[]> {
  const scope = { clubId: access.club.id, now: ctx.now(), tz, excludeUserId: access.user.id };
  const size = async (key: AudienceKey) => (await audienceMembers(ctx.db, key, scope)).length;
  const club = access.club.name;
  const list: Suggestion[] = [];
  const inactive = await size('inactive_30');
  if (inactive > 0) list.push({ key: 'comeback', kind: 'comeback', audience: 'inactive_30', params: { count: inactive, club } });
  const newcomers = await size('new_14');
  if (newcomers > 0) list.push({ key: 'welcome', kind: 'welcome', audience: 'new_14', params: { count: newcomers, club } });
  if (await size('tourney_month') > 0) {
    const tournaments = await tournamentTargets(ctx.db, access.club.id, scope.now);
    for (const tr of tournaments.filter((x) => x.status !== 'running').slice(0, MAX_TOURNAMENT_SUGGESTIONS)) {
      list.push({
        key: `tournament:${tr.id}`, kind: 'tournament', audience: 'tourney_month',
        params: { name: tr.name, startsAt: tr.startsAt, club }, action: { type: 'tournament', ref: tr.id, label: tr.name },
      });
    }
  }
  if (await size('active_7') > 0) {
    for (const table of (await openTables(ctx.db, access.club.id)).filter((x) => x.hasDealer)) {
      list.push({
        key: `table:${table.id}`, kind: 'table', audience: 'active_7',
        params: { table: table.name, club }, action: { type: 'table', ref: table.id, label: table.name },
      });
    }
  }
  return list;
}

/** GET /messages/suggestions: ready-made messages, minus the ones snoozed with "Not now". */
export async function listSuggestions(ctx: AppContext, access: ClubAccess, tz: string): Promise<Suggestion[]> {
  const snoozed = await ctx.db.select({ key: messageSuggestionDismissals.key }).from(messageSuggestionDismissals).where(and(
    eq(messageSuggestionDismissals.clubId, access.club.id),
    gt(messageSuggestionDismissals.dismissedAt, new Date(ctx.now().getTime() - SUGGESTION_SNOOZE_MS)),
  ));
  const hidden = new Set(snoozed.map((s) => s.key));
  return (await candidates(ctx, access, tz)).filter((s) => !hidden.has(s.key));
}

export async function dismissSuggestion(ctx: AppContext, access: ClubAccess, key: string, tz: string): Promise<{ key: string }> {
  const current = await candidates(ctx, access, tz);
  if (!current.some((s) => s.key === key)) throw new AppError('messages.suggestion_unknown', 404);
  const now = ctx.now();
  await ctx.db.insert(messageSuggestionDismissals)
    .values({ clubId: access.club.id, key, dismissedBy: access.user.id, dismissedAt: now })
    .onConflictDoUpdate({
      target: [messageSuggestionDismissals.clubId, messageSuggestionDismissals.key],
      set: { dismissedBy: access.user.id, dismissedAt: now },
    });
  return { key };
}
