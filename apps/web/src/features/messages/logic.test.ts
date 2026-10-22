import { describe, expect, it } from 'vitest';
import {
  actionPath, dataUrlBytes, draftAction, draftFromSuggestion, emptyDraft, fromLocalInput, reachLines,
  toComposeBody, toLocalInput, validateDraft, type Draft,
} from './logic';
import type { Audience, Suggestion, Targets } from './types';

const NOW = new Date('2026-09-24T18:00:00');
const audiences: Audience[] = [
  { key: 'all', count: 8, total: 10, muted: 1, capped: 1 },
  { key: 'new_14', count: 0, total: 0, muted: 0, capped: 0 },
  { key: 'member', count: 10, total: 10, muted: 0, capped: 0 },
];
const draft = (patch: Partial<Draft> = {}): Draft => ({ ...emptyDraft(NOW), body: 'Hello', ...patch });
const keys = (d: Draft) => validateDraft(d, audiences, NOW).map((p) => p.key);

describe('composer validation', () => {
  it('accepts a simple message to everyone', () => {
    expect(keys(draft())).toEqual([]);
  });

  it('needs a body within 2,000 characters and a title within 120', () => {
    expect(keys(draft({ body: '   ' }))).toEqual(['err_messages_body_required']);
    expect(keys(draft({ body: 'x'.repeat(2000) }))).toEqual([]);
    const tooLong = validateDraft(draft({ body: 'x'.repeat(2001) }), audiences, NOW);
    expect(tooLong).toEqual([{ field: 'body', key: 'err_messages_too_long', params: { max: 2000 } }]);
    expect(validateDraft(draft({ title: 't'.repeat(121) }), audiences, NOW)[0]).toMatchObject({ field: 'title', params: { max: 120 } });
    expect(keys(draft({ title: 't'.repeat(120) }))).toEqual([]);
  });

  it('needs a member when writing to one member, and a reachable group', () => {
    expect(keys(draft({ audience: 'member' }))).toEqual(['msg_err_member']);
    expect(keys(draft({ audience: 'member', recipient: { userId: 'u', username: 'al', displayName: 'Al' } }))).toEqual([]);
    expect(keys(draft({ audience: 'new_14' }))).toEqual(['msg_err_audience_empty']);
  });

  it('caps the photo at 120 KB', () => {
    expect(keys(draft({ photo: 'data:image/jpeg;base64,AAAA', photoBytes: 120 * 1024 }))).toEqual([]);
    expect(keys(draft({ photo: 'data:image/jpeg;base64,AAAA', photoBytes: 120 * 1024 + 1 }))).toEqual(['err_messages_photo_too_large']);
  });

  it('schedules between 1 minute and 30 days ahead', () => {
    const at = (ms: number) => toLocalInput(new Date(NOW.getTime() + ms));
    expect(keys(draft({ when: 'later', sendAtLocal: 'soon' }))).toEqual(['err_messages_schedule_invalid']);
    expect(keys(draft({ when: 'later', sendAtLocal: at(0) }))).toEqual(['err_messages_schedule_past']);
    expect(keys(draft({ when: 'later', sendAtLocal: at(60_000) }))).toEqual([]);
    expect(keys(draft({ when: 'later', sendAtLocal: at(30 * 86_400_000) }))).toEqual([]);
    expect(keys(draft({ when: 'later', sendAtLocal: at(31 * 86_400_000) }))).toEqual(['err_messages_schedule_too_far']);
    // Default schedule is one hour ahead.
    expect(fromLocalInput(emptyDraft(NOW).sendAtLocal)?.getTime()).toBe(NOW.getTime() + 3_600_000);
  });
});

describe('composer helpers', () => {
  const targets: Targets = { tables: [{ id: 't1', name: 'Main', hasDealer: true }], tournaments: [{ id: 'x', name: 'Cup', startsAt: null, status: 'upcoming' }] };

  it('builds the request body', () => {
    expect(toComposeBody(draft({ title: '  ', body: ' Hi ' }), 'Europe/Athens')).toEqual({ title: null, body: 'Hi', tz: 'Europe/Athens', audience: 'all' });
    const full = toComposeBody(draft({
      audience: 'member', recipient: { userId: 'u1', username: 'a', displayName: 'A' }, title: 'T',
      actionKey: 'table:t1', when: 'later', sendAtLocal: toLocalInput(new Date(NOW.getTime() + 3_600_000)), photo: 'data:x', photoBytes: 3,
    }), 'UTC');
    expect(full).toEqual({
      title: 'T', body: 'Hello', tz: 'UTC', recipientId: 'u1', action: { type: 'table', ref: 't1' },
      sendAt: new Date(NOW.getTime() + 3_600_000).toISOString(), photo: 'data:x',
    });
  });

  it('resolves the button label from the targets', () => {
    expect(draftAction(draft({ actionKey: 'tournament:x' }), targets)).toEqual({ type: 'tournament', ref: 'x', label: 'Cup' });
    expect(draftAction(draft({ actionKey: 'table:gone' }), targets)).toBeNull();
    expect(draftAction(draft(), targets)).toBeNull();
  });

  it('explains the reach', () => {
    expect(reachLines(draft(), audiences)).toEqual([
      { key: 'msg_reach', params: { n: 8 } },
      { key: 'msg_reach_muted', params: { n: 1 } },
      { key: 'msg_reach_capped', params: { n: 1 } },
    ]);
    expect(reachLines(draft({ audience: 'member', recipient: { userId: 'u', username: 'a', displayName: 'Ann' } }), audiences))
      .toEqual([{ key: 'msg_reach_one', params: { name: 'Ann' } }]);
    expect(reachLines(draft({ audience: 'member' }), audiences)).toEqual([]);
  });

  it('pre-fills a draft from a suggestion', () => {
    const s: Suggestion = { key: 'table:t1', kind: 'table', audience: 'active_7', params: { table: 'Main' }, action: { type: 'table', ref: 't1', label: 'Main' } };
    const next = draftFromSuggestion(draft(), s, (key, params) => `${key}:${params.table}`);
    expect(next).toMatchObject({ audience: 'active_7', title: 'msg_tpl_table_title:Main', body: 'msg_tpl_table_body:Main', actionKey: 'table:t1' });
  });

  it('knows where buttons lead and how big a data URL is', () => {
    expect(actionPath({ type: 'table', ref: 'a' })).toBe('/player/table/a');
    expect(actionPath({ type: 'tournament', ref: 'b' })).toBe('/tournaments/b');
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
  });
});
