import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { AppContext } from '../../context.js';
import { clubTables, clubs, type TvKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';
import { requireClub, type Capability } from '../clubs/access.js';
import { tournamentTvSource } from './tournamentSource.js';

/** What a TV follows, resolved and access-checked. */
export interface TvTarget {
  readonly kind: TvKind;
  readonly id: string;
  readonly clubId: string;
  readonly name: string;
}

export interface TargetCheck {
  /** Launching needs an open Ring Game table; listing and revoking do not. */
  readonly forLaunch: boolean;
}

const CAPABILITY: Record<TvKind, Capability> = { cash: 'floor', tournament: 'tournaments' };

function assertSameClub(req: Request, clubId: string): void {
  const selected = req.header('x-club-id');
  if (selected && selected !== clubId) throw new AppError('tv.club_mismatch', 403);
}

async function cashTarget(ctx: AppContext, tableId: string, check: TargetCheck): Promise<Omit<TvTarget, 'kind'>> {
  const [row] = await ctx.db.select({ table: clubTables, clubStatus: clubs.status }).from(clubTables)
    .leftJoin(clubs, eq(clubs.id, clubTables.clubId)).where(eq(clubTables.id, tableId)).limit(1);
  if (!row || row.table.status === 'archived') throw new AppError('tv.table_not_found', 404);
  if (!row.clubStatus || row.clubStatus === 'deleted') throw new AppError('tv.club_missing', 404);
  if (check.forLaunch && row.table.kind !== 'cash') throw new AppError('tv.cash_only');
  return { id: row.table.id, clubId: row.table.clubId, name: row.table.name };
}

async function tournamentTarget(ctx: AppContext, tournamentId: string): Promise<Omit<TvTarget, 'kind'>> {
  const info = await tournamentTvSource().find(ctx.db, tournamentId);
  if (!info) throw new AppError('tournament.not_found', 404);
  return { id: info.id, clubId: info.clubId, name: info.name };
}

/** Loads the target, checks it belongs to the selected club and that the user is staff there. */
export async function resolveTarget(
  ctx: AppContext, req: Request, user: AuthUser, kind: TvKind, targetId: string, check: TargetCheck,
): Promise<TvTarget> {
  const base = kind === 'cash' ? await cashTarget(ctx, targetId, check) : await tournamentTarget(ctx, targetId);
  assertSameClub(req, base.clubId);
  await requireClub(ctx.db, req, user, CAPABILITY[kind], base.clubId);
  if (kind === 'cash' && check.forLaunch) await assertTableOpen(ctx, base.id);
  return { ...base, kind };
}

async function assertTableOpen(ctx: AppContext, tableId: string): Promise<void> {
  const [table] = await ctx.db.select({ status: clubTables.status }).from(clubTables).where(eq(clubTables.id, tableId)).limit(1);
  if (table?.status !== 'open') throw new AppError('tv.table_closed', 409);
}

/** Current display name of a target (table renamed, tournament renamed), for claim responses. */
export async function targetName(ctx: AppContext, kind: TvKind, targetId: string): Promise<string | null> {
  if (kind === 'cash') {
    const [table] = await ctx.db.select({ name: clubTables.name, status: clubTables.status }).from(clubTables)
      .where(eq(clubTables.id, targetId)).limit(1);
    return table && table.status !== 'archived' ? table.name : null;
  }
  return (await tournamentTvSource().find(ctx.db, targetId))?.name ?? null;
}

export { CAPABILITY as TV_CAPABILITY };
