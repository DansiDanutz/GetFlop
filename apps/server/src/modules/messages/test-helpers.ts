import { DEFAULT_LIMITS } from '@getflop/engine';
import { and, eq } from 'drizzle-orm';
import { clubTables, coupons, memberships } from '../../db/schema/index.js';
import type { Agent, TestEnv } from '../../test/harness.js';

/** Test-only helpers for the messages module (direct DB seeding of activity). */

export async function seedTable(env: TestEnv, clubId: string, opts: { name?: string; open?: boolean; dealerId?: string | null; tournamentId?: string } = {}): Promise<string> {
  const [row] = await env.db.insert(clubTables).values({
    clubId, name: opts.name ?? 'Table 1', status: opts.open === false ? 'closed' : 'open',
    dealerId: opts.dealerId ?? null, kind: opts.tournamentId ? 'tournament' : 'cash',
    tournamentId: opts.tournamentId ?? null, limits: { ...DEFAULT_LIMITS, marketMaxCents: {} },
  }).returning();
  return row!.id;
}

export async function seedCoupon(env: TestEnv, clubId: string, tableId: string, userId: string, opts: { at?: Date; tournamentId?: string; committedCents?: number } = {}): Promise<void> {
  await env.db.insert(coupons).values({
    clubId, tableId, userId, rounds: 1, committedCents: opts.committedCents ?? 100, startHandNumber: 1,
    tournamentId: opts.tournamentId ?? null, unit: opts.tournamentId ? 'chips' : 'points',
    createdAt: opts.at ?? env.clock.now(),
  });
}

export async function setJoinedAt(env: TestEnv, clubId: string, userId: string, at: Date): Promise<void> {
  await env.db.update(memberships).set({ reviewedAt: at, createdAt: at })
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId)));
}

export async function setMembership(env: TestEnv, clubId: string, userId: string, patch: Partial<typeof memberships.$inferInsert>): Promise<void> {
  await env.db.update(memberships).set(patch).where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId)));
}

/** A tiny valid PNG (1×1) as a data URL, padded to `bytes` when asked. */
export function pngDataUrl(bytes?: number): string {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const body = bytes && bytes > png.length ? Buffer.concat([png, Buffer.alloc(bytes - png.length)]) : png;
  return `data:image/png;base64,${body.toString('base64')}`;
}

/** Requests from `agent` acting in `clubId` (X-Club-Id). */
export function scoped(agent: Agent, clubId: string) {
  return {
    get: (path: string) => agent.get(`/api${path}`).set('X-Club-Id', clubId),
    post: (path: string, body: object = {}) => agent.post(`/api${path}`).set('X-Club-Id', clubId).send(body),
    put: (path: string, body: object = {}) => agent.put(`/api${path}`).set('X-Club-Id', clubId).send(body),
  };
}
