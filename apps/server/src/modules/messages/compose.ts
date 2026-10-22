import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubMessages, type MessageActionJson } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { ClubAccess } from '../clubs/access.js';
import { isAudienceKey, reachFor } from './audiences.js';
import {
  BODY_MAX, DAY_MS, MEMBER_AUDIENCE, SCHEDULE_MAX_DAYS, SCHEDULE_MIN_AHEAD_MS, TITLE_MAX, type AudienceKey,
} from './constants.js';
import { announce, insertRecipients, isActiveMember, resolveRecipients } from './delivery.js';
import { parsePhoto, type Photo } from './photo.js';
import { assertBroadcastQuota } from './quota.js';
import { openTables, tournamentTargets } from './targets.js';
import { parseTz } from './time.js';

export const composeSchema = z.object({
  title: z.string().nullish(),
  body: z.string().nullish(),
  tz: z.string().nullish(),
  audience: z.string().nullish(),
  recipientId: z.string().nullish(),
  action: z.unknown().optional(),
  sendAt: z.union([z.string(), z.number()]).nullish(),
  photo: z.string().nullish(),
});
export type ComposeInput = z.infer<typeof composeSchema>;

export interface ComposeResult {
  readonly id: string;
  readonly scheduled: boolean;
  readonly sendAt: string | null;
  readonly recipientCount: number;
}

export function validateText(title: string | null | undefined, body: string | null | undefined): { title: string | null; body: string } {
  const cleanBody = (body ?? '').trim();
  if (!cleanBody) throw new AppError('messages.body_required', 400);
  if (cleanBody.length > BODY_MAX) throw new AppError('messages.too_long', 400, { max: BODY_MAX });
  const cleanTitle = (title ?? '').trim();
  if (cleanTitle.length > TITLE_MAX) throw new AppError('messages.too_long', 400, { max: TITLE_MAX });
  return { title: cleanTitle || null, body: cleanBody };
}

/** null = send now. */
export function validateSendAt(value: string | number | null | undefined, now: Date): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) throw new AppError('messages.schedule_invalid', 400);
  if (when.getTime() < now.getTime() + SCHEDULE_MIN_AHEAD_MS) throw new AppError('messages.schedule_past', 400);
  if (when.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * DAY_MS) {
    throw new AppError('messages.schedule_too_far', 400, { days: SCHEDULE_MAX_DAYS });
  }
  return when;
}

const actionShape = z.object({ type: z.enum(['table', 'tournament']), ref: z.string().min(1).max(64) });

export async function resolveAction(db: DbOrTx, clubId: string, raw: unknown, now: Date): Promise<MessageActionJson | null> {
  if (raw === undefined || raw === null) return null;
  const parsed = actionShape.safeParse(raw);
  if (!parsed.success) throw new AppError('messages.action_unknown', 400);
  const { type, ref } = parsed.data;
  const targets = type === 'table' ? await openTables(db, clubId) : await tournamentTargets(db, clubId, now);
  const target = targets.find((x) => x.id === ref);
  if (!target) throw new AppError('messages.action_unavailable', 409);
  return { type, ref, label: target.name };
}

type Addressee = { readonly audience: AudienceKey } | { readonly audience: typeof MEMBER_AUDIENCE; readonly recipientId: string };

async function resolveAddressee(db: DbOrTx, access: ClubAccess, input: ComposeInput): Promise<Addressee> {
  if (input.recipientId || input.audience === MEMBER_AUDIENCE) {
    const recipientId = input.recipientId ?? '';
    if (!recipientId || recipientId === access.user.id || !await isActiveMember(db, access.club.id, recipientId)) {
      throw new AppError('messages.member_not_found', 404);
    }
    return { audience: MEMBER_AUDIENCE, recipientId };
  }
  if (!isAudienceKey(input.audience)) throw new AppError('messages.audience_unknown', 400);
  return { audience: input.audience };
}

interface Draft {
  readonly addressee: Addressee;
  readonly title: string | null;
  readonly body: string;
  readonly tz: string;
  readonly action: MessageActionJson | null;
  readonly sendAt: Date | null;
  readonly photo: Photo | null;
}

async function buildDraft(ctx: AppContext, access: ClubAccess, input: ComposeInput): Promise<Draft> {
  const now = ctx.now();
  const { title, body } = validateText(input.title, input.body);
  const tz = parseTz(input.tz);
  const addressee = await resolveAddressee(ctx.db, access, input);
  const action = await resolveAction(ctx.db, access.club.id, input.action, now);
  const sendAt = validateSendAt(input.sendAt, now);
  const photo = input.photo ? parsePhoto(input.photo) : null;
  return { addressee, title, body, tz, action, sendAt, photo };
}

function rowValues(access: ClubAccess, d: Draft) {
  return {
    clubId: access.club.id, authorId: access.user.id, audience: d.addressee.audience,
    recipientId: 'recipientId' in d.addressee ? d.addressee.recipientId : null,
    title: d.title, body: d.body, tz: d.tz, action: d.action,
    photoData: d.photo?.base64 ?? null, photoMime: d.photo?.mime ?? null,
  };
}

async function schedule(ctx: AppContext, access: ClubAccess, d: Draft, sendAt: Date): Promise<ComposeResult> {
  let estimate = 1;
  if (d.addressee.audience !== MEMBER_AUDIENCE) {
    const reach = await reachFor(ctx.db, d.addressee.audience, { clubId: access.club.id, now: ctx.now(), tz: d.tz, excludeUserId: access.user.id });
    // Capped members may be free again by then; muted ones will not.
    estimate = reach.total - reach.muted;
    if (estimate <= 0) throw new AppError('messages.empty_audience', 409, { muted: reach.muted, capped: 0 });
  }
  const [row] = await ctx.db.insert(clubMessages).values({
    ...rowValues(access, d), status: 'scheduled', sendAt, recipientCount: estimate, createdAt: ctx.now(),
  }).returning();
  ctx.events.emit(rooms.staff(access.club.id), 'messages:changed', { messageId: row!.id });
  return { id: row!.id, scheduled: true, sendAt: sendAt.toISOString(), recipientCount: estimate };
}

async function sendNow(ctx: AppContext, access: ClubAccess, d: Draft): Promise<ComposeResult> {
  const now = ctx.now();
  const values = rowValues(access, d);
  const result = await ctx.db.transaction(async (tx) => {
    const resolution = await resolveRecipients(tx, { ...values, recipientId: values.recipientId }, now);
    if (!resolution.ok) {
      if (resolution.reason === 'member_left') throw new AppError('messages.member_not_found', 404);
      throw new AppError('messages.empty_audience', 409, { muted: resolution.muted, capped: resolution.capped });
    }
    const [row] = await tx.insert(clubMessages).values({
      ...values, status: 'sent', sentAt: now, createdAt: now, recipientCount: resolution.userIds.length,
      mutedCount: resolution.muted, cappedCount: resolution.capped,
    }).returning();
    await insertRecipients(tx, row!, resolution.userIds, resolution.isDirect, now);
    return { row: row!, userIds: resolution.userIds };
  });
  announce(ctx, result.row, result.userIds);
  return { id: result.row.id, scheduled: false, sendAt: null, recipientCount: result.userIds.length };
}

/** POST /messages: validates, applies the quota, then sends now or schedules. */
export async function composeMessage(ctx: AppContext, access: ClubAccess, input: ComposeInput): Promise<ComposeResult> {
  const draft = await buildDraft(ctx, access, input);
  if (draft.addressee.audience !== MEMBER_AUDIENCE) {
    await assertBroadcastQuota(ctx.db, access, draft.sendAt ?? ctx.now());
  }
  return draft.sendAt ? schedule(ctx, access, draft, draft.sendAt) : sendNow(ctx, access, draft);
}

/** POST /messages/:id/cancel — only while it is still waiting to go out. */
export async function cancelScheduled(ctx: AppContext, access: ClubAccess, id: string): Promise<{ id: string; status: 'cancelled' }> {
  const [existing] = await ctx.db.select({ id: clubMessages.id }).from(clubMessages)
    .where(and(eq(clubMessages.id, id), eq(clubMessages.clubId, access.club.id))).limit(1);
  if (!existing) throw new AppError('messages.not_found', 404);
  const [row] = await ctx.db.update(clubMessages).set({ status: 'cancelled', cancelledAt: ctx.now() })
    .where(and(eq(clubMessages.id, id), eq(clubMessages.status, 'scheduled'))).returning({ id: clubMessages.id });
  if (!row) throw new AppError('messages.not_scheduled', 409);
  ctx.events.emit(rooms.staff(access.club.id), 'messages:changed', { messageId: id });
  return { id, status: 'cancelled' };
}
