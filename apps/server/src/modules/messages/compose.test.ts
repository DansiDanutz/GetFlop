import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMember, grantRole, setupClub, type ClubFixture } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { pngDataUrl, scoped, seedTable } from './test-helpers.js';

let env: TestEnv;
let club: ClubFixture;
const HOUR = 3_600_000;

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: ['alice', 'bob', 'carol'], pointsEach: 0 });
});
afterEach(async () => { await env.close(); });

const as = (agent: Agent) => scoped(agent, club.clubId);
const member = (i: number) => () => club.players[i]!;
const alice = member(0);
const bob = member(1);
const carol = member(2);

describe('messages — permissions', () => {
  it('lets only the owner and managers write; staff read the log; players neither', async () => {
    expect(errCode(await as(alice()).get('/messages/audiences'))).toBe('club.capability_missing');
    expect(errCode(await as(alice()).post('/messages', { audience: 'all', body: 'hi' }))).toBe('club.capability_missing');
    expect(errCode(await as(alice()).get('/messages/sent'))).toBe('club.capability_missing');

    await grantRole(env, club.clubId, bob().userId, 'inspector');
    expect(errCode(await as(bob()).post('/messages', { audience: 'all', body: 'hi' }))).toBe('club.capability_missing');
    const log = ok(await as(bob()).get('/messages/sent'));
    expect(log.canWrite).toBe(false);

    await grantRole(env, club.clubId, carol().userId, 'manager');
    const sent = ok(await as(carol()).post('/messages', { audience: 'all', body: 'From the manager' }));
    expect(sent).toMatchObject({ scheduled: false, recipientCount: 3 });
    expect(ok(await as(carol()).get('/messages/sent')).canWrite).toBe(true);
  });

  it('rejects non-members of the club', async () => {
    const stranger = await env.login('stranger');
    expect(errCode(await as(stranger).get('/messages/prefs'))).toBe('club.access_denied');
  });
});

describe('messages — validation', () => {
  const send = (body: object) => as(club.owner).post('/messages', { audience: 'all', body: 'Hello', ...body });

  it('checks text, audience and recipient', async () => {
    expect(errCode(await send({ body: '   ' }))).toBe('messages.body_required');
    const long = await send({ body: 'x'.repeat(2001) });
    expect(errCode(long)).toBe('messages.too_long');
    expect(long.body.error.params).toEqual({ max: 2000 });
    expect(errCode(await send({ title: 't'.repeat(121) }))).toBe('messages.too_long');
    expect(ok(await send({ title: 't'.repeat(120), body: 'b'.repeat(2000) })).recipientCount).toBe(3);
    expect(errCode(await send({ audience: 'nobody_group' }))).toBe('messages.audience_unknown');
    expect(errCode(await send({ audience: undefined }))).toBe('messages.audience_unknown');
    expect(errCode(await send({ audience: undefined, recipientId: 'missing' }))).toBe('messages.member_not_found');
    expect(errCode(await send({ audience: undefined, recipientId: club.owner.userId }))).toBe('messages.member_not_found');
    expect(errCode(await send({ tz: 'Mars/Olympus' }))).toBe('validation.invalid');
  });

  it('checks the button target', async () => {
    expect(errCode(await send({ action: { type: 'lottery', ref: 'x' } }))).toBe('messages.action_unknown');
    expect(errCode(await send({ action: { type: 'table' } }))).toBe('messages.action_unknown');
    expect(errCode(await send({ action: { type: 'table', ref: 'nope' } }))).toBe('messages.action_unavailable');
    const closed = await seedTable(env, club.clubId, { name: 'Closed', open: false });
    expect(errCode(await send({ action: { type: 'table', ref: closed } }))).toBe('messages.action_unavailable');
    expect(errCode(await send({ action: { type: 'tournament', ref: 'none' } }))).toBe('messages.action_unavailable');
    const open = await seedTable(env, club.clubId, { name: 'Main', open: true });
    const targets = ok(await as(club.owner).get('/messages/targets'));
    expect(targets.tables).toEqual([{ id: open, name: 'Main', hasDealer: false }]);
    expect(targets.tournaments).toEqual([]);
    ok(await send({ action: { type: 'table', ref: open } }));
    const { messages } = ok(await as(alice()).get('/messages'));
    expect(messages[0].action).toEqual({ type: 'table', ref: open, label: 'Main' });
  });

  it('checks the schedule window', async () => {
    const now = env.clock.now().getTime();
    expect(errCode(await send({ sendAt: 'not a date' }))).toBe('messages.schedule_invalid');
    expect(errCode(await send({ sendAt: new Date(now - HOUR).toISOString() }))).toBe('messages.schedule_past');
    expect(errCode(await send({ sendAt: new Date(now + 30_000).toISOString() }))).toBe('messages.schedule_past');
    const far = await send({ sendAt: new Date(now + 31 * 24 * HOUR).toISOString() });
    expect(errCode(far)).toBe('messages.schedule_too_far');
    expect(far.body.error.params).toEqual({ days: 30 });
    expect(ok(await send({ sendAt: new Date(now + 30 * 24 * HOUR).toISOString() })).scheduled).toBe(true);
  });

  it('checks the photo type and size', async () => {
    expect(errCode(await send({ photo: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }))).toBe('messages.photo_invalid');
    expect(errCode(await send({ photo: 'data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD' }))).toBe('messages.photo_invalid');
    expect(errCode(await send({ photo: 'hello' }))).toBe('messages.photo_invalid');
    const big = await send({ photo: pngDataUrl(120 * 1024 + 1) });
    expect(errCode(big)).toBe('messages.photo_too_large');
    expect(big.body.error.params).toEqual({ maxKb: 120 });
    expect(ok(await send({ photo: pngDataUrl(120 * 1024) })).recipientCount).toBe(3);
  });
});

describe('messages — delivery rules', () => {
  it('delivers to everyone but the writer and emits message:new to each user room', async () => {
    const res = ok(await as(club.owner).post('/messages', { audience: 'all', title: 'Friday', body: 'Big night' }));
    expect(res.recipientCount).toBe(3);
    const rooms = env.events.named('message:new').map((e) => e.room).sort();
    expect(rooms).toEqual(club.players.map((p) => `user:${p.userId}`).sort());
    expect(ok(await as(club.owner).get('/messages')).messages).toHaveLength(0);
    const inbox = ok(await as(alice()).get('/messages'));
    expect(inbox.unread).toBe(1);
    expect(inbox.messages[0]).toMatchObject({ title: 'Friday', body: 'Big night', clubName: 'Sharks Imperial', read: false, direct: false });
    expect(ok(await as(alice()).post('/messages/read-all')).updated).toBe(1);
    expect(ok(await as(alice()).get('/messages')).unread).toBe(0);
  });

  it('skips and counts players who already had a group message in the last 24 hours', async () => {
    ok(await as(club.owner).post('/messages', { audience: 'all', body: 'First' }));
    const again = await as(club.owner).post('/messages', { audience: 'all', body: 'Second' });
    expect(errCode(again)).toBe('messages.empty_audience');
    expect(again.body.error.params).toEqual({ muted: 0, capped: 3 });
    const aud = ok(await as(club.owner).get('/messages/audiences')).audiences.find((a: { key: string }) => a.key === 'all');
    expect(aud).toMatchObject({ count: 0, total: 3, capped: 3 });

    // A new member is not capped yet: the message goes to them only.
    const dave = await env.login('dave');
    await addMember(env, club.owner, club.clubId, dave);
    const partial = ok(await as(club.owner).post('/messages', { audience: 'all', body: 'Third' }));
    expect(partial.recipientCount).toBe(1);
    const sent = ok(await as(club.owner).get('/messages/sent')).messages[0];
    expect(sent).toMatchObject({ recipientCount: 1, cappedCount: 3, status: 'sent' });

    env.clock.advance(24 * HOUR + 1);
    expect(ok(await as(club.owner).post('/messages', { audience: 'all', body: 'Next day' })).recipientCount).toBe(4);
  });

  it('always delivers a direct message, which ignores mute and the cap and does not use it up', async () => {
    ok(await as(alice()).put('/messages/prefs', { promoMuted: true }));
    ok(await as(club.owner).post('/messages', { audience: 'all', body: 'Group' }));
    const direct = ok(await as(club.owner).post('/messages', { recipientId: alice().userId, body: 'Just for you' }));
    expect(direct.recipientCount).toBe(1);
    ok(await as(club.owner).post('/messages', { recipientId: bob().userId, body: 'Your table is ready' }));
    const inbox = ok(await as(alice()).get('/messages'));
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ direct: true, body: 'Just for you' });
    expect(ok(await as(bob()).get('/messages')).messages).toHaveLength(2);
  });

  it('skips and counts muted members; the switch is per club', async () => {
    expect(ok(await as(alice()).get('/messages/prefs'))).toEqual({ clubId: club.clubId, clubName: 'Sharks Imperial', promoMuted: false });
    expect(ok(await as(alice()).put('/messages/prefs', { promoMuted: true })).promoMuted).toBe(true);
    expect(errCode(await as(alice()).put('/messages/prefs', { promoMuted: 'yes' }))).toBe('validation.invalid');
    const all = ok(await as(club.owner).get('/messages/audiences')).audiences.find((a: { key: string }) => a.key === 'all');
    expect(all).toMatchObject({ count: 2, muted: 1, capped: 0 });
    const res = ok(await as(club.owner).post('/messages', { audience: 'all', body: 'Hi' }));
    expect(res.recipientCount).toBe(2);
    expect(ok(await as(alice()).get('/messages')).messages).toHaveLength(0);

    ok(await as(alice()).put('/messages/prefs', { promoMuted: false }));
    ok(await as(alice()).put('/messages/prefs', { promoMuted: true }));
    expect(ok(await as(alice()).get('/messages/prefs')).promoMuted).toBe(true);
  });

  it('reports an empty audience with the muted and capped split', async () => {
    for (const p of club.players) ok(await as(p).put('/messages/prefs', { promoMuted: true }));
    const res = await as(club.owner).post('/messages', { audience: 'all', body: 'Anyone?' });
    expect(errCode(res)).toBe('messages.empty_audience');
    expect(res.body.error.params).toEqual({ muted: 3, capped: 0 });
    expect(errCode(await as(club.owner).post('/messages', { audience: 'new_14', body: 'x', sendAt: new Date(env.clock.now().getTime() + HOUR).toISOString() })))
      .toBe('messages.empty_audience');
  });

  it('lists members for the one-member picker with search', async () => {
    const { players } = ok(await as(club.owner).get('/messages/players'));
    expect(players.map((p: { username: string }) => p.username)).toEqual(['alice', 'bob', 'carol']);
    const { players: found } = ok(await as(club.owner).get('/messages/players?q=BO'));
    expect(found).toEqual([{ userId: bob().userId, username: 'bob', displayName: 'bob' }]);
    expect(ok(await as(club.owner).get('/messages/players?q=%25')).players).toEqual([]);
  });
});
