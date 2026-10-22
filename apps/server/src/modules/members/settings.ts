import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubs } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms as rt } from '../../realtime/events.js';
import { assertName } from '../auth/validation.js';
import { can, type Club, type ClubAccess } from '../clubs/access.js';
import { listRooms } from './rooms.js';

/** Default "big pick" threshold: 10 Points. */
export const DEFAULT_LIVE_BIG_CENTS = 1_000;
const DESCRIPTION_MAX = 1_000;

type ClubSettingsJson = Record<string, unknown>;

/** Live "big pick" threshold in cents (Reports → Live flags picks and wins at or above it). */
export function liveBigCents(club: Pick<Club, 'settings'>): number {
  const value = (club.settings as ClubSettingsJson).liveBigCents;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_LIVE_BIG_CENTS;
}

export function boardEnabled(club: Pick<Club, 'settings'>): boolean {
  return (club.settings as ClubSettingsJson).boardEnabled === true;
}

export function inviteUrl(ctx: AppContext, publicId: string): string {
  return `${ctx.config.publicAppUrl.replace(/\/$/, '')}/c/${publicId}`;
}

export function assertSettingsAccess(access: ClubAccess): void {
  if (!can(access, 'settings')) throw new AppError('club.settings_forbidden', 403);
}

/** Points typed by staff (> 0, at most 2 decimals) → cents, or the given error code. */
export function pointsToCents(value: unknown, code: string): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new AppError(code);
  const cents = Math.round(Number(text) * 100);
  if (cents <= 0) throw new AppError(code);
  return cents;
}

async function reload(ctx: AppContext, clubId: string): Promise<Club> {
  const [club] = await ctx.db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  if (!club) throw new AppError('club.not_found', 404);
  return club;
}

export async function settingsView(ctx: AppContext, club: Club) {
  return {
    id: club.id, publicId: club.publicId, name: club.name, description: club.description, photoUrl: club.photoUrl,
    level: club.level, dealerSitApproval: club.dealerSitApproval, liveBigCents: liveBigCents(club), boardEnabled: boardEnabled(club),
    inviteUrl: inviteUrl(ctx, club.publicId), rooms: await listRooms(ctx.db, club.id),
  };
}

function changed(ctx: AppContext, clubId: string): void {
  ctx.events.emit(rt.club(clubId), 'club:context-changed', { clubId, quiet: true });
}

export interface ProfileInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly logo?: string | null;
}

export async function updateProfile(ctx: AppContext, access: ClubAccess, input: ProfileInput, validateLogo: (v: string) => string) {
  assertSettingsAccess(access);
  const club = access.club;
  const patch: Partial<Club> = {};
  if (input.name !== undefined) {
    const name = assertName(input.name, { min: 3, max: 80, code: 'club.name_invalid' });
    if (name !== club.name) patch.name = name;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > DESCRIPTION_MAX) throw new AppError('club.description_too_long');
    if (description !== club.description) patch.description = description;
  }
  if (input.logo !== undefined) {
    const photo = input.logo === null || input.logo === '' ? null : validateLogo(input.logo);
    if (photo !== club.photoUrl) patch.photoUrl = photo;
  }
  if (Object.keys(patch).length === 0) throw new AppError('club.nothing_to_change');
  await ctx.db.update(clubs).set(patch).where(eq(clubs.id, club.id));
  changed(ctx, club.id);
  return settingsView(ctx, await reload(ctx, club.id));
}

export interface SettingsInput {
  readonly dealerSitApproval?: boolean;
  readonly liveBigPoints?: unknown;
  readonly boardEnabled?: boolean;
}

export async function updateSettings(ctx: AppContext, access: ClubAccess, input: SettingsInput) {
  assertSettingsAccess(access);
  const club = access.club;
  const json: ClubSettingsJson = { ...(club.settings as ClubSettingsJson) };
  if (input.liveBigPoints !== undefined) json.liveBigCents = pointsToCents(input.liveBigPoints, 'club.live_big_invalid');
  if (input.boardEnabled !== undefined) json.boardEnabled = input.boardEnabled;
  await ctx.db.update(clubs).set({
    settings: json, ...(input.dealerSitApproval === undefined ? {} : { dealerSitApproval: input.dealerSitApproval }),
  }).where(eq(clubs.id, club.id));
  changed(ctx, club.id);
  return settingsView(ctx, await reload(ctx, club.id));
}

/** Records that staff shared the invite link (the "players" setup step). */
export async function markInviteShared(ctx: AppContext, access: ClubAccess): Promise<void> {
  if (!can(access, 'members.review')) throw new AppError('club.capability_missing', 403);
  const json = { ...(access.club.settings as ClubSettingsJson), inviteSharedAt: ctx.now().toISOString() };
  await ctx.db.update(clubs).set({ settings: json }).where(eq(clubs.id, access.club.id));
}
