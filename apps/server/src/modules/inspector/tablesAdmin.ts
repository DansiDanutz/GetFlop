import { randomBytes } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubTables, clubs, couponLegs, coupons, hands, memberships, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { standUp } from '../game/dealer.js';
import { emitTableChanged, getTable, liveHand, type TableRow } from '../game/tables.js';
import { clubTournaments, displayName, userNames } from './queries.js';

// ── Delete / archive (07 §2.4) ──

export interface DeleteBlocker { readonly code: string; readonly params: Record<string, string | number> }

export interface DeletePreview {
  readonly mode: 'delete' | 'archive';
  readonly history: { readonly hands: number; readonly coupons: number };
  readonly dealer: { readonly id: string; readonly name: string } | null;
  readonly blocked: DeleteBlocker | null;
}

const FINISHED_TOURNAMENT = new Set(['finished', 'cancelled']);

async function tournamentBlocker(db: DbOrTx, table: TableRow): Promise<DeleteBlocker | null> {
  if (!table.tournamentId) return null;
  const [trn] = await clubTournaments(db, table.clubId, [table.tournamentId]);
  if (trn && FINISHED_TOURNAMENT.has(trn.status)) return null;
  return { code: 'table_delete.tournament', params: { tournament: trn?.name ?? '' } };
}

async function computePreview(db: DbOrTx, table: TableRow): Promise<DeletePreview> {
  const [h] = await db.select({ n: count() }).from(hands).where(eq(hands.tableId, table.id));
  const [c] = await db.select({ n: count() }).from(coupons).where(eq(coupons.tableId, table.id));
  const [riding] = await db.select({ n: count() }).from(coupons).where(and(eq(coupons.tableId, table.id), eq(coupons.status, 'live')));
  const hand = await liveHand(db, table.id);
  const names = await userNames(db, [table.dealerId]);
  const history = { hands: h?.n ?? 0, coupons: c?.n ?? 0 };
  const blocked = (await tournamentBlocker(db, table))
    ?? (hand ? { code: 'table_delete.hand_live', params: { hand: hand.handNumber } } : null)
    ?? ((riding?.n ?? 0) > 0 ? { code: 'table_delete.coupons_riding', params: { n: riding!.n } } : null);
  return {
    mode: history.hands === 0 && history.coupons === 0 ? 'delete' : 'archive',
    history,
    dealer: table.dealerId ? { id: table.dealerId, name: names.get(table.dealerId) ?? '' } : null,
    blocked,
  };
}

export async function deletePreview(ctx: AppContext, access: ClubAccess, tableId: string): Promise<DeletePreview> {
  assertCan(access, 'tables.edit');
  return computePreview(ctx.db, await getTable(ctx.db, access.club.id, tableId));
}

/**
 * Deletes a never-played table for good, or archives a played one (history stays in reports).
 * `expectMode` is the mode the confirm showed; a different mode now means the table changed.
 */
export async function deleteTable(ctx: AppContext, access: ClubAccess, tableId: string, expectMode?: 'delete' | 'archive') {
  assertCan(access, 'tables.edit');
  const clubId = access.club.id;
  const before = await getTable(ctx.db, clubId, tableId);
  const first = await computePreview(ctx.db, before);
  if (first.blocked) throw new AppError(first.blocked.code, 409, first.blocked.params);
  if (expectMode && expectMode !== first.mode) throw new AppError('table_delete.changed', 409);
  if (before.dealerId) await standUp(ctx, clubId, tableId, before.dealerId, 'floor');
  const mode = await ctx.db.transaction(async (tx) => {
    const table = await getTable(tx, clubId, tableId, true);
    const now = await computePreview(tx, table);
    if (now.blocked || now.mode !== first.mode) throw new AppError('table_delete.changed', 409);
    if (now.mode === 'delete') await tx.delete(clubTables).where(eq(clubTables.id, tableId));
    else await tx.update(clubTables).set({ status: 'archived', dealerId: null, featured: false }).where(eq(clubTables.id, tableId));
    return now.mode;
  });
  ctx.events.emit(rooms.table(tableId), 'table:closed', { tableId });
  ctx.events.emit(rooms.staff(clubId), 'floor:changed', { tableId });
  return { mode, name: before.name, history: first.history };
}

// ── Lobby card (07 §2.5) ──

export const PHOTO_MAX_BYTES = 300 * 1024;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

/** Validates a data-URL photo. Returns it unchanged when valid. */
export function assertLobbyPhoto(photo: string): string {
  const match = PHOTO_RE.exec(photo);
  if (!match) throw new AppError('table_card.photo_invalid');
  const bytes = Math.floor((match[2]!.length * 3) / 4);
  if (bytes > PHOTO_MAX_BYTES) throw new AppError('table_card.photo_too_large', 413, { maxKb: PHOTO_MAX_BYTES / 1024 });
  return photo;
}

export interface LobbyCardInput {
  readonly game: string;
  readonly featured: boolean;
  /** Data URL to set, null to remove, undefined to keep. */
  readonly photo?: string | null;
}

export async function setLobbyCard(ctx: AppContext, access: ClubAccess, tableId: string, input: LobbyCardInput): Promise<TableRow> {
  assertCan(access, 'tables.edit');
  const table = await getTable(ctx.db, access.club.id, tableId);
  if (table.kind === 'tournament') throw new AppError('table_card.tournament');
  if (!['nlh', 'plo', 'other'].includes(input.game)) throw new AppError('table_card.game_invalid');
  const photoUrl = input.photo === undefined ? table.photoUrl : input.photo === null ? null : assertLobbyPhoto(input.photo);
  const [updated] = await ctx.db.update(clubTables).set({ game: input.game, featured: input.featured, photoUrl })
    .where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, updated!);
  return updated!;
}

// ── Join code (07 §2.5 Table QR) ──

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function newJoinCode(): string {
  return [...randomBytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Replaces the join code: every printed QR of the table stops working. Owner or manager. */
export async function regenerateJoinCode(ctx: AppContext, access: ClubAccess, tableId: string): Promise<string> {
  assertCan(access, 'limits.edit');
  await getTable(ctx.db, access.club.id, tableId);
  const joinCode = newJoinCode();
  const [updated] = await ctx.db.update(clubTables).set({ joinCode }).where(eq(clubTables.id, tableId)).returning();
  emitTableChanged(ctx, updated!);
  return joinCode;
}

/** GET /tables/:joinCode/info — the table QR landing (no membership needed). */
export async function tableInfo(ctx: AppContext, code: string) {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(clean)) throw new AppError('table.not_found', 404);
  const [row] = await ctx.db.select({ table: clubTables, club: clubs }).from(clubTables)
    .innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(eq(sql`upper(${clubTables.joinCode})`, clean)).limit(1);
  if (!row || row.table.status === 'archived' || row.club.status === 'deleted') throw new AppError('table.not_found', 404);
  const hand = await liveHand(ctx.db, row.table.id);
  return {
    id: row.table.id, name: row.table.name, kind: row.table.kind, status: row.table.status,
    activeHandStatus: hand?.status ?? null, activeHandNumber: hand?.handNumber ?? null,
    club: { id: row.club.id, name: row.club.name, publicId: row.club.publicId, photoUrl: row.club.photoUrl },
  };
}

// ── Dealers list for the pickers ──

export async function dealersList(ctx: AppContext, access: ClubAccess) {
  assertCan(access, 'floor');
  const clubId = access.club.id;
  const rows = await ctx.db.select({ id: users.id, username: users.username, displayName: users.displayName, roles: memberships.roles })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active')));
  const dealers = rows.filter((r) => r.roles.includes('dealer'));
  if (dealers.length === 0) return [];
  const seats = await ctx.db.select({ id: clubTables.id, name: clubTables.name, clubId: clubTables.clubId, dealerId: clubTables.dealerId })
    .from(clubTables).where(and(inArray(clubTables.dealerId, dealers.map((d) => d.id)), inArray(clubTables.status, ['open', 'closed'])));
  return dealers.map((d) => {
    const seat = seats.find((s) => s.dealerId === d.id);
    const here = seat?.clubId === clubId ? seat : undefined;
    return {
      id: d.id, username: d.username, displayName: displayName(d),
      assignedTable: here?.name ?? null, assignedTableId: here?.id ?? null,
      busyElsewhere: Boolean(seat && seat.clubId !== clubId),
    };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ── Close preview with the per-coupon list (07 §2.3) ──

export async function detailedClosePreview(ctx: AppContext, access: ClubAccess, tableId: string) {
  const table = await getTable(ctx.db, access.club.id, tableId);
  const hand = await liveHand(ctx.db, table.id);
  const live = await ctx.db.select().from(coupons).where(and(eq(coupons.tableId, table.id), eq(coupons.status, 'live')));
  const legs = live.length === 0 ? [] : await ctx.db.select().from(couponLegs)
    .where(and(inArray(couponLegs.couponId, live.map((c) => c.id)), eq(couponLegs.status, 'active')));
  const names = await userNames(ctx.db, live.map((c) => c.userId));
  const list = live.map((c) => {
    const perRound = legs.filter((l) => l.couponId === c.id).reduce((s, l) => s + l.stakeCents, 0);
    const drawsLeft = c.rounds - c.roundsSettled;
    return { couponId: c.id, userId: c.userId, player: names.get(c.userId) ?? '', drawsLeft, refundCents: perRound * drawsLeft, unit: c.unit };
  });
  const [trn] = table.tournamentId ? await clubTournaments(ctx.db, table.clubId, [table.tournamentId]) : [];
  const totalRefundCents = list.filter((x) => x.unit === 'points').reduce((s, x) => s + x.refundCents, 0);
  return {
    table: { id: table.id, name: table.name, kind: table.kind },
    hasActiveHand: Boolean(hand), activeHandNumber: hand?.handNumber ?? null,
    couponCount: list.length, playerCount: new Set(list.map((x) => x.userId)).size,
    totalRefundCents, coupons: list,
    tournamentName: trn?.name ?? null, tournamentRunning: trn ? trn.status === 'active' : false,
    // Kept for existing callers.
    liveCoupons: list.length, refundCents: totalRefundCents,
  };
}
