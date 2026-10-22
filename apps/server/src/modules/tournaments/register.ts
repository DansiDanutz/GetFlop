import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { clubs, clubTables, memberships, tournaments, users } from '../../db/schema/index.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { highestRank, requireClub, ROLE_RANK, type Capability } from '../clubs/access.js';
import { levelOf } from '../commerce/levels.js';
import { heldTable } from '../game/dealer.js';
import { registerFunds } from '../game/funds.js';
import { hooks } from '../game/hooks.js';
import type { ModuleRegistrar } from '../index.js';
import { addJob } from '../jobs.js';
import { AUTO_DEAL_JOB_MS, runTournamentJobs } from './autodeal.js';
import { chipsFunds, tournamentPreCheck, tournamentStartGuard } from './chips.js';
import { afterTournamentHand, onTournamentHandSettled } from './progress.js';
import { addon, rebuy, register, unregister } from './registration.js';
import { tournamentReport } from './report.js';
import { AUTO_DEAL_MAX_SECONDS, AUTO_DEAL_MIN_SECONDS } from './rules.js';
import { cancel, createTournament, finish, startAutoDeal, startTournament, stopAutoDeal, togglePin } from './service.js';
import { getTournament } from './store.js';
import { listTournaments, logs, monitor, summary, tournamentDetail } from './views.js';

// ── Extension points (run once, at import) ──
registerFunds('chips', chipsFunds);
hooks.couponPreChecks.push(tournamentPreCheck);
hooks.startGuards.push(tournamentStartGuard);
hooks.settled.push(onTournamentHandSettled);
hooks.afterSettled.push(afterTournamentHand);
addJob({ name: 'tournaments', everyMs: AUTO_DEAL_JOB_MS, run: (ctx) => runTournamentJobs(ctx) });

const int = z.number().int();
const levelSchema = z.object({ levelNumber: int.optional(), minBetChips: z.number().optional(), maxBetChips: z.number().optional(), endHand: z.number().optional() });

const createSchema = z.object({
  clubId: z.string().optional(),
  name: z.string().max(200).optional(),
  tableId: z.string().nullable().optional(),
  dealerId: z.string().nullable().optional(),
  autoDealSeconds: z.number().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
  autoStart: z.boolean().optional(),
  pinned: z.boolean().optional(),
  botsAllowed: z.boolean().optional(),
  buyInCents: int.optional(), feeCents: int.optional(), startingStack: int.optional(),
  allowRebuys: z.boolean().optional(), maxRebuys: int.optional(), rebuyStack: int.optional(),
  rebuyCostCents: int.optional(), rebuyFeeCents: int.optional(), rebuyEndHand: int.optional(),
  allowAddons: z.boolean().optional(), addonCostCents: int.optional(), addonStack: int.optional(), addonEndHand: int.optional(),
  minActionPct: z.number().optional(),
  allowLateRegistration: z.boolean().optional(), lateRegEndHand: int.optional(),
  allowedBetTypeIds: z.array(z.string()).max(64).optional(),
  levels: z.array(levelSchema).max(100).optional(),
  prizePoolType: z.enum(['guaranteed', 'progressive']).optional(),
  guaranteedPrizeCents: int.optional(),
  payoutStructure: z.union([z.array(z.unknown()).max(100), z.string().max(500)]).optional(),
  endCondition: z.enum(['hands', 'manual']).optional(),
  endValue: int.optional(),
});

export const registerTournaments: ModuleRegistrar = (api, ctx) => {
  /** The tournament plus the caller's access to its club. */
  async function scoped(req: Request, capability: Capability) {
    const t = await getTournament(ctx.db, String(req.params.id));
    const access = await requireClub(ctx.db, req, currentUser(req), capability, t.clubId);
    return { t, access };
  }

  // ── Lobby and staff lists ──
  api.get('/tournaments', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'view');
    return { tournaments: await listTournaments(ctx, access.club.id, user.id) };
  }));

  api.get('/inspector/tournaments', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'tournaments');
    const level = levelOf(access.club.level);
    return { tournaments: await listTournaments(ctx, access.club.id, user.id, { includeCancelled: true }), limit: level.tournaments };
  }));

  api.get('/tournaments/clubs/list', handle(async (req) => {
    const user = currentUser(req);
    const rows = user.isPlatformAdmin
      ? (await ctx.db.select().from(clubs).where(eq(clubs.status, 'active'))).map((club) => ({ club, roles: [] as string[] }))
      : (await ctx.db.select({ club: clubs, roles: memberships.roles }).from(memberships).innerJoin(clubs, eq(clubs.id, memberships.clubId))
        .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active'), eq(clubs.status, 'active'))))
        .filter((r) => highestRank(r.roles) >= ROLE_RANK.inspector);
    return { clubs: rows.map(({ club }) => ({ id: club.id, name: club.name, level: club.level, tournamentsAllowed: levelOf(club.level).tournaments })) };
  }));

  // Wizard helpers: dealers (busy ones flagged) and free tournament tables.
  api.get('/tournaments/dealers/list', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'tournaments');
    const rows = await ctx.db.select({ id: users.id, username: users.username, displayName: users.displayName, roles: memberships.roles })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.clubId, access.club.id), eq(memberships.status, 'active')));
    const dealers = rows.filter((r) => r.roles.includes('dealer'));
    return {
      dealers: await Promise.all(dealers.map(async (d) => {
        const held = await heldTable(ctx.db, d.id);
        return { id: d.id, name: d.displayName ?? d.username, busyElsewhere: Boolean(held), tableName: held?.table.name ?? null };
      })),
    };
  }));

  api.get('/tournaments/tables/free', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'tournaments');
    const tables = await ctx.db.select().from(clubTables)
      .where(and(eq(clubTables.clubId, access.club.id), eq(clubTables.kind, 'tournament'), ne(clubTables.status, 'archived')));
    const busy = tables.length === 0 ? [] : await ctx.db.select({ tableId: tournaments.tableId }).from(tournaments)
      .where(and(inArray(tournaments.tableId, tables.map((t) => t.id)), inArray(tournaments.status, ['upcoming', 'active'])));
    const taken = new Set(busy.map((b) => b.tableId));
    return { tables: tables.filter((t) => !taken.has(t.id)).map((t) => ({ id: t.id, name: t.name })) };
  }));

  // ── Create ──
  api.post('/tournaments', handle(async (req) => {
    const body = createSchema.parse(req.body ?? {});
    const access = await requireClub(ctx.db, req, currentUser(req), 'tournaments', body.clubId);
    const t = await createTournament(ctx, access, body);
    return { tournament: summary(t, { entrants: 0, inPlay: 0, collected: 0 }) };
  }));

  // ── Detail and player actions ──
  api.get('/tournaments/:id', handle(async (req) => {
    const { t, access } = await scoped(req, 'view');
    return tournamentDetail(ctx, t, access.user.id);
  }));

  api.post('/tournaments/:id/register', handle(async (req) => register(ctx, (await scoped(req, 'view')).access, String(req.params.id))));
  api.post('/tournaments/:id/unregister', handle(async (req) => unregister(ctx, (await scoped(req, 'view')).access, String(req.params.id))));
  api.post('/tournaments/:id/rebuy', handle(async (req) => rebuy(ctx, (await scoped(req, 'view')).access, String(req.params.id))));
  api.post('/tournaments/:id/addon', handle(async (req) => addon(ctx, (await scoped(req, 'view')).access, String(req.params.id))));

  // ── Staff controls ──
  api.post('/tournaments/:id/pin', handle(async (req) => {
    const { t } = await scoped(req, 'tournaments');
    return togglePin(ctx, t.id);
  }));

  api.post('/tournaments/:id/start', handle(async (req) => {
    const { t, access } = await scoped(req, 'tournaments');
    const started = await startTournament(ctx, access, t.id);
    return { tournament: { id: started.id, status: started.status, tableId: started.tableId } };
  }));

  api.post('/tournaments/:id/cancel', handle(async (req) => {
    const { t, access } = await scoped(req, 'tournaments');
    const { tournament, refundedCents } = await cancel(ctx, access, t.id);
    return { tournament: { id: tournament.id, status: tournament.status }, refundedCents };
  }));

  api.post('/tournaments/:id/finish', handle(async (req) => {
    const { t, access } = await scoped(req, 'tournaments');
    const result = await finish(ctx, access, t.id);
    return { tournament: { id: result.tournament.id, status: result.tournament.status }, poolCents: result.poolCents, standings: result.standings };
  }));

  api.post('/tournaments/:id/auto-deal', handle(async (req) => {
    const { intervalSeconds } = z.object({ intervalSeconds: int.min(AUTO_DEAL_MIN_SECONDS).max(AUTO_DEAL_MAX_SECONDS) }).parse(req.body ?? {});
    const { t } = await scoped(req, 'tournaments');
    return startAutoDeal(ctx, t.id, intervalSeconds);
  }));

  api.delete('/tournaments/:id/auto-deal', handle(async (req) => {
    const { t } = await scoped(req, 'tournaments');
    return stopAutoDeal(ctx, t.id);
  }));

  api.get('/tournaments/:id/monitor', handle(async (req) => monitor(ctx, (await scoped(req, 'tournaments')).t)));
  api.get('/tournaments/:id/logs', handle(async (req) => logs(ctx, (await scoped(req, 'tournaments')).t.id)));
  api.get('/tournaments/:id/report', handle(async (req) => tournamentReport(ctx, (await scoped(req, 'tournaments')).t)));
};
