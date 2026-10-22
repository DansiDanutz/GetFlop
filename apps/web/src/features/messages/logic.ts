import type { Params } from '../../i18n/i18n';
import type {
  Audience, AudienceChoice, ComposeBody, MessageAction, PlayerOption, Suggestion, Targets,
} from './types';

/** Same limits as the server (08 §6); the server re-validates everything. */
export const TITLE_MAX = 120;
export const BODY_MAX = 2_000;
export const PHOTO_MAX_KB = 120;
export const PHOTO_MAX_BYTES = PHOTO_MAX_KB * 1024;
export const SCHEDULE_MAX_DAYS = 30;
export const SCHEDULE_MIN_AHEAD_MS = 60_000;
export const SCHEDULE_DEFAULT_AHEAD_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

export interface Draft {
  readonly audience: AudienceChoice;
  readonly recipient: PlayerOption | null;
  readonly title: string;
  readonly body: string;
  /** Compressed photo as a data URL, and its decoded size. */
  readonly photo: string | null;
  readonly photoBytes: number;
  /** '' (no button) or 'table:<id>' / 'tournament:<id>'. */
  readonly actionKey: string;
  readonly when: 'now' | 'later';
  /** <input type="datetime-local"> value, local time. */
  readonly sendAtLocal: string;
}

export function emptyDraft(now: Date): Draft {
  return {
    audience: 'all', recipient: null, title: '', body: '', photo: null, photoBytes: 0,
    actionKey: '', when: 'now', sendAtLocal: toLocalInput(new Date(now.getTime() + SCHEDULE_DEFAULT_AHEAD_MS)),
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Date → "YYYY-MM-DDTHH:mm" in the browser's timezone. */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface Problem { readonly field: 'audience' | 'title' | 'body' | 'photo' | 'when'; readonly key: string; readonly params?: Params }

/** Everything wrong with a draft, in field order. Empty means it can be sent. */
export function validateDraft(draft: Draft, audiences: readonly Audience[] | undefined, now: Date): Problem[] {
  const problems: Problem[] = [];
  if (draft.audience === 'member') {
    if (!draft.recipient) problems.push({ field: 'audience', key: 'msg_err_member' });
  } else {
    const audience = audiences?.find((a) => a.key === draft.audience);
    if (audience && audience.count === 0) problems.push({ field: 'audience', key: 'msg_err_audience_empty' });
  }
  if (draft.title.trim().length > TITLE_MAX) problems.push({ field: 'title', key: 'err_messages_too_long', params: { max: TITLE_MAX } });
  const body = draft.body.trim();
  if (!body) problems.push({ field: 'body', key: 'err_messages_body_required' });
  else if (body.length > BODY_MAX) problems.push({ field: 'body', key: 'err_messages_too_long', params: { max: BODY_MAX } });
  if (draft.photo && draft.photoBytes > PHOTO_MAX_BYTES) {
    problems.push({ field: 'photo', key: 'err_messages_photo_too_large', params: { maxKb: PHOTO_MAX_KB } });
  }
  if (draft.when === 'later') {
    const at = fromLocalInput(draft.sendAtLocal);
    if (!at) problems.push({ field: 'when', key: 'err_messages_schedule_invalid' });
    else if (at.getTime() < now.getTime() + SCHEDULE_MIN_AHEAD_MS) problems.push({ field: 'when', key: 'err_messages_schedule_past' });
    else if (at.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * DAY_MS) {
      problems.push({ field: 'when', key: 'err_messages_schedule_too_far', params: { days: SCHEDULE_MAX_DAYS } });
    }
  }
  return problems;
}

export function parseActionKey(key: string): { type: 'table' | 'tournament'; ref: string } | null {
  const match = /^(table|tournament):(.+)$/.exec(key);
  return match ? { type: match[1] as 'table' | 'tournament', ref: match[2]! } : null;
}

/** The button the draft carries, with its target name, or null. */
export function draftAction(draft: Draft, targets: Targets | undefined): MessageAction | null {
  const parsed = parseActionKey(draft.actionKey);
  if (!parsed || !targets) return null;
  const list = parsed.type === 'table' ? targets.tables : targets.tournaments;
  const target = list.find((x) => x.id === parsed.ref);
  return target ? { ...parsed, label: target.name } : null;
}

export function toComposeBody(draft: Draft, tz: string): ComposeBody {
  const action = parseActionKey(draft.actionKey);
  const sendAt = draft.when === 'later' ? fromLocalInput(draft.sendAtLocal) : null;
  return {
    title: draft.title.trim() || null,
    body: draft.body.trim(),
    tz,
    ...(draft.audience === 'member' ? { recipientId: draft.recipient?.userId } : { audience: draft.audience }),
    ...(action ? { action } : {}),
    ...(sendAt ? { sendAt: sendAt.toISOString() } : {}),
    ...(draft.photo ? { photo: draft.photo } : {}),
  };
}

export interface ReachLine { readonly key: string; readonly params: Params }

/** "Will reach n members" + muted / capped notes, or "Will reach <name> only". */
export function reachLines(draft: Draft, audiences: readonly Audience[] | undefined): ReachLine[] {
  if (draft.audience === 'member') {
    return draft.recipient ? [{ key: 'msg_reach_one', params: { name: draft.recipient.displayName } }] : [];
  }
  const audience = audiences?.find((a) => a.key === draft.audience);
  if (!audience) return [];
  const lines: ReachLine[] = [{ key: 'msg_reach', params: { n: audience.count } }];
  if (audience.muted > 0) lines.push({ key: 'msg_reach_muted', params: { n: audience.muted } });
  if (audience.capped > 0) lines.push({ key: 'msg_reach_capped', params: { n: audience.capped } });
  return lines;
}

/** A suggestion's template keys (title, body) — texts live in the dictionary. */
export function suggestionTemplate(s: Suggestion): { titleKey: string; bodyKey: string } {
  return { titleKey: `msg_tpl_${s.kind}_title`, bodyKey: `msg_tpl_${s.kind}_body` };
}

/** "Use it": a new draft pre-filled from a suggestion. */
export function draftFromSuggestion(base: Draft, s: Suggestion, translate: (key: string, params: Params) => string): Draft {
  const { titleKey, bodyKey } = suggestionTemplate(s);
  return {
    ...base,
    audience: s.audience, recipient: null,
    title: translate(titleKey, s.params).slice(0, TITLE_MAX),
    body: translate(bodyKey, s.params).slice(0, BODY_MAX),
    actionKey: s.action ? `${s.action.type}:${s.action.ref}` : '',
  };
}

/** Where a message button leads in the player app. */
export function actionPath(action: { type: 'table' | 'tournament'; ref: string }): string {
  return action.type === 'table' ? `/player/table/${action.ref}` : `/tournaments/${action.ref}`;
}

/** Decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
