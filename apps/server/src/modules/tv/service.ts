import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { tvPairings, tvSessions, type TvKind } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { newToken, numericCode, sha256 } from '../auth/crypto.js';
import {
  DISPLAY_TTL_MS, PAIRING_CODE_ATTEMPTS, PAIRING_CODE_DIGITS, PAIRING_TTL_MINUTES, TV_PATH,
} from './constants.js';
import { disconnectTv } from './socket.js';
import { targetName, type TvTarget } from './targets.js';

export type TvSessionRow = typeof tvSessions.$inferSelect;
type Via = 'pairing' | 'link';

const MINUTE_MS = 60_000;
const CODE_PATTERN = new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`);

const tvUrl = (ctx: AppContext, path: string): string => `${ctx.config.publicAppUrl}/#${path}`;

async function codeInUse(db: DbOrTx, code: string, now: Date): Promise<boolean> {
  const [row] = await db.select({ id: tvPairings.id }).from(tvPairings).where(and(
    eq(tvPairings.code, code), isNull(tvPairings.claimedAt), isNull(tvPairings.supersededAt), gt(tvPairings.expiresAt, now),
  )).limit(1);
  return Boolean(row);
}

/** Staff phone: a fresh 6-digit code for a table or tournament. Older unclaimed codes for the same target stop working. */
export async function createPairing(ctx: AppContext, target: TvTarget, userId: string) {
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MINUTES * MINUTE_MS);
  const pairing = await ctx.db.transaction(async (tx) => {
    await tx.update(tvPairings).set({ supersededAt: now }).where(and(
      eq(tvPairings.kind, target.kind), eq(tvPairings.targetId, target.id), isNull(tvPairings.claimedAt), isNull(tvPairings.supersededAt),
    ));
    for (let attempt = 0; attempt < PAIRING_CODE_ATTEMPTS; attempt += 1) {
      const code = numericCode(PAIRING_CODE_DIGITS);
      if (await codeInUse(tx, code, now)) continue;
      const [row] = await tx.insert(tvPairings).values({
        clubId: target.clubId, kind: target.kind, targetId: target.id, code, createdBy: userId, expiresAt, createdAt: now,
      }).returning();
      return row!;
    }
    throw new AppError('tv.pairing_unavailable', 503);
  });
  return {
    pairingId: pairing.id,
    pairingCode: pairing.code,
    expiresInMinutes: PAIRING_TTL_MINUTES,
    expiresAt: pairing.expiresAt,
    tvPath: TV_PATH[target.kind],
    tvUrl: tvUrl(ctx, TV_PATH[target.kind]),
  };
}

async function insertSession(db: DbOrTx, ctx: AppContext, input: { clubId: string; kind: TvKind; targetId: string; userId: string; via: Via }) {
  const token = newToken();
  const now = ctx.now();
  const [session] = await db.insert(tvSessions).values({
    clubId: input.clubId, kind: input.kind, targetId: input.targetId, tokenHash: sha256(token), via: input.via,
    createdBy: input.userId, expiresAt: new Date(now.getTime() + DISPLAY_TTL_MS), createdAt: now,
  }).returning();
  return { session: session!, token };
}

/** Parses what the TV typed: 6 digits, spaces allowed ("123 456"). */
export function normalizeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/\s+/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

export type ClaimFailure = 'tv.pairing_code_invalid' | 'tv.pairing_expired';

export type ClaimResult =
  | { readonly ok: true; readonly displayToken: string; readonly name: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly code: ClaimFailure };

/** TV: exchanges a code for a 24-hour display token. Failures are returned (not thrown) so the caller can rate-limit them. */
export async function claimPairing(ctx: AppContext, kind: TvKind, rawCode: unknown): Promise<ClaimResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, code: 'tv.pairing_code_invalid' };
  const now = ctx.now();
  const [pairing] = await ctx.db.select().from(tvPairings)
    .where(and(eq(tvPairings.code, code), eq(tvPairings.kind, kind), isNull(tvPairings.claimedAt)))
    .orderBy(desc(tvPairings.createdAt)).limit(1);
  if (!pairing) return { ok: false, code: 'tv.pairing_code_invalid' };
  if (pairing.supersededAt || pairing.expiresAt <= now) return { ok: false, code: 'tv.pairing_expired' };
  const name = await targetName(ctx, kind, pairing.targetId);
  if (name === null) return { ok: false, code: 'tv.pairing_code_invalid' };

  const created = await ctx.db.transaction(async (tx) => {
    const [taken] = await tx.update(tvPairings).set({ claimedAt: now })
      .where(and(eq(tvPairings.id, pairing.id), isNull(tvPairings.claimedAt))).returning({ id: tvPairings.id });
    if (!taken) return null;
    const result = await insertSession(tx, ctx, {
      clubId: pairing.clubId, kind, targetId: pairing.targetId, userId: pairing.createdBy, via: 'pairing',
    });
    await tx.update(tvPairings).set({ sessionId: result.session.id }).where(eq(tvPairings.id, pairing.id));
    return result;
  });
  if (!created) return { ok: false, code: 'tv.pairing_code_invalid' };

  ctx.events.emit(rooms.staff(pairing.clubId), 'tv:connected', {
    pairingId: pairing.id, sessionId: created.session.id, kind, targetId: pairing.targetId, name,
  });
  return { ok: true, displayToken: created.token, name, expiresAt: created.session.expiresAt };
}

/** Direct-link fallback: a new link for the target; the previous link stops working. */
export async function createDirectSession(ctx: AppContext, target: TvTarget, userId: string) {
  const now = ctx.now();
  const { replaced, created } = await ctx.db.transaction(async (tx) => {
    const old = await tx.update(tvSessions).set({ revokedAt: now }).where(and(
      eq(tvSessions.kind, target.kind), eq(tvSessions.targetId, target.id), eq(tvSessions.via, 'link'), isNull(tvSessions.revokedAt),
    )).returning({ id: tvSessions.id });
    const fresh = await insertSession(tx, ctx, { clubId: target.clubId, kind: target.kind, targetId: target.id, userId, via: 'link' });
    return { replaced: old, created: fresh };
  });
  replaced.forEach(({ id }) => announceRevoked(ctx, id));
  const tvPath = `${TV_PATH[target.kind]}/${created.token}`;
  return { sessionId: created.session.id, token: created.token, expiresAt: created.session.expiresAt, tvPath, tvUrl: tvUrl(ctx, tvPath) };
}

/** Active displays of a target, newest first. Tokens are never returned. */
export async function listSessions(ctx: AppContext, target: TvTarget) {
  const list = await ctx.db.select().from(tvSessions).where(and(
    eq(tvSessions.kind, target.kind), eq(tvSessions.targetId, target.id), isNull(tvSessions.revokedAt), gt(tvSessions.expiresAt, ctx.now()),
  )).orderBy(desc(tvSessions.createdAt));
  return list.map((s) => ({
    id: s.id, kind: s.kind, via: s.via, createdAt: s.createdAt, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt,
  }));
}

export async function findSession(ctx: AppContext, sessionId: string): Promise<TvSessionRow> {
  const [session] = await ctx.db.select().from(tvSessions).where(eq(tvSessions.id, sessionId)).limit(1);
  if (!session) throw new AppError('tv.session_not_found', 404);
  return session;
}

export async function revokeSession(ctx: AppContext, session: TvSessionRow): Promise<void> {
  if (!session.revokedAt) {
    await ctx.db.update(tvSessions).set({ revokedAt: ctx.now() }).where(eq(tvSessions.id, session.id));
  }
  announceRevoked(ctx, session.id);
}

function announceRevoked(ctx: AppContext, sessionId: string): void {
  ctx.events.emit(rooms.tv(sessionId), 'tv:revoked', { sessionId });
  disconnectTv(ctx, sessionId);
}

/** The live session behind a display token, or null (unknown, revoked, expired or another kind). */
export async function activeSession(ctx: AppContext, token: string, kind?: TvKind): Promise<TvSessionRow | null> {
  if (!token) return null;
  const conditions = [eq(tvSessions.tokenHash, sha256(token)), isNull(tvSessions.revokedAt), gt(tvSessions.expiresAt, ctx.now())];
  if (kind) conditions.push(eq(tvSessions.kind, kind));
  const [session] = await ctx.db.select().from(tvSessions).where(and(...conditions)).limit(1);
  return session ?? null;
}

/** Same as activeSession but throws 410 tv.display_expired, and records that the TV was seen. */
export async function requireDisplay(ctx: AppContext, token: string, kind: TvKind): Promise<TvSessionRow> {
  const session = await activeSession(ctx, token, kind);
  if (!session) throw new AppError('tv.display_expired', 410);
  await ctx.db.update(tvSessions).set({ lastSeenAt: ctx.now() }).where(eq(tvSessions.id, session.id));
  return session;
}
