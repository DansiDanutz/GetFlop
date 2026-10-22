import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clubMessages } from '../../db/schema/index.js';
import { grantRole, setupClub, type ClubFixture } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { jobs } from '../jobs.js';
import { deliverDueMessages } from './delivery.js';
import { scoped, setMembership } from './test-helpers.js';

let env: TestEnv;
let club: ClubFixture;
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: ['alice', 'bob'], pointsEach: 0 });
});
afterEach(async () => { await env.close(); });

const owner = () => scoped(club.owner, club.clubId);
const inHours = (h: number) => new Date(env.clock.now().getTime() + h * HOUR).toISOString();

describe('scheduled messages', () => {
  it('registers the delivery job once', () => {
    expect(jobs.filter((j) => j.name === 'messages-scheduled-delivery')).toHaveLength(1);
  });

  it('waits until the send time, then delivers and tells the writer', async () => {
    const res = ok(await owner().post('/messages', { audience: 'all', body: 'Tonight 21:00', sendAt: inHours(1) }));
    expect(res).toMatchObject({ scheduled: true, recipientCount: 2, sendAt: inHours(1) });
    const { scheduled, messages } = ok(await owner().get('/messages/sent'));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ status: 'scheduled', sendAt: inHours(1), authorName: 'owner' });
    expect(messages).toHaveLength(0);

    await deliverDueMessages(env.ctx);
    expect(ok(await scoped(club.players[0]!, club.clubId).get('/messages')).messages).toHaveLength(0);

    env.clock.advance(HOUR);
    expect(await deliverDueMessages(env.ctx)).toBe(1);
    expect(ok(await scoped(club.players[0]!, club.clubId).get('/messages')).messages).toHaveLength(1);
    const after = ok(await owner().get('/messages/sent'));
    expect(after.scheduled).toHaveLength(0);
    expect(after.messages[0]).toMatchObject({ status: 'sent', recipientCount: 2, stats: { reached: 2, opened: 0, tapped: 0, joined: 0 } });
    expect(env.events.named('message:new')).toHaveLength(2);
    expect(env.events.named('notice:new')).toEqual([
      { room: `user:${club.owner.userId}`, event: 'notice:new', payload: { code: 'messages.scheduled_sent', params: { count: 2 } } },
    ]);
    // Idempotent: a second run finds nothing.
    expect(await deliverDueMessages(env.ctx)).toBe(0);
  });

  it('counts the audience again at send time (mute and the daily cap apply then)', async () => {
    ok(await owner().post('/messages', { audience: 'all', body: 'Later', sendAt: inHours(2) }));
    ok(await owner().post('/messages', { audience: 'all', body: 'Now' }));
    ok(await scoped(club.players[1]!, club.clubId).put('/messages/prefs', { promoMuted: true }));
    env.clock.advance(2 * HOUR);
    await deliverDueMessages(env.ctx);
    const [failed] = ok(await owner().get('/messages/sent')).messages;
    expect(failed).toMatchObject({ body: 'Later', status: 'failed', failReason: 'nobody', mutedCount: 1, cappedCount: 1 });
    expect(env.events.named('notice:new').at(-1)?.payload).toEqual({ code: 'messages.scheduled_failed', params: { reason: 'nobody' } });
  });

  it('can be cancelled until it goes out', async () => {
    const { id } = ok(await owner().post('/messages', { audience: 'all', body: 'Maybe', sendAt: inHours(1) }));
    expect(errCode(await scoped(club.players[0]!, club.clubId).post(`/messages/${id}/cancel`))).toBe('club.capability_missing');
    expect(ok(await owner().post(`/messages/${id}/cancel`))).toEqual({ id, status: 'cancelled' });
    expect(errCode(await owner().post(`/messages/${id}/cancel`))).toBe('messages.not_scheduled');
    expect(errCode(await owner().post('/messages/unknown/cancel'))).toBe('messages.not_found');
    env.clock.advance(2 * HOUR);
    expect(await deliverDueMessages(env.ctx)).toBe(0);
    const [row] = ok(await owner().get('/messages/sent')).messages;
    expect(row).toMatchObject({ status: 'cancelled', sendAt: expect.any(String), cancelledAt: expect.any(String) });

    const sent = ok(await owner().post('/messages', { audience: 'all', body: 'Now' }));
    expect(errCode(await owner().post(`/messages/${sent.id}/cancel`))).toBe('messages.not_scheduled');
  });

  it('fails when its writer no longer manages the club', async () => {
    await grantRole(env, club.clubId, club.players[0]!.userId, 'manager');
    const manager = scoped(club.players[0]!, club.clubId);
    ok(await manager.post('/messages', { audience: 'all', body: 'From a manager', sendAt: inHours(1) }));
    await setMembership(env, club.clubId, club.players[0]!.userId, { roles: [] });
    env.clock.advance(HOUR);
    await deliverDueMessages(env.ctx);
    const [row] = ok(await owner().get('/messages/sent')).messages;
    expect(row).toMatchObject({ status: 'failed', failReason: 'writer_gone' });
  });

  it('fails a direct message when the member has left', async () => {
    ok(await owner().post('/messages', { recipientId: club.players[0]!.userId, body: 'See you', sendAt: inHours(1) }));
    await setMembership(env, club.clubId, club.players[0]!.userId, { status: 'left' });
    env.clock.advance(HOUR);
    await deliverDueMessages(env.ctx);
    const [row] = ok(await owner().get('/messages/sent')).messages;
    expect(row).toMatchObject({ status: 'failed', failReason: 'member_left', audience: 'member', recipientName: 'alice' });
  });

  it('marks a delivery that crashes as interrupted and keeps going', async () => {
    const { id } = ok(await owner().post('/messages', { audience: 'all', body: 'Boom', sendAt: inHours(1) }));
    env.clock.advance(HOUR);
    const spy = vi.spyOn(env.ctx.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
    await deliverDueMessages(env.ctx);
    spy.mockRestore();
    const [row] = await env.db.select().from(clubMessages).where(eq(clubMessages.id, id));
    expect(row).toMatchObject({ status: 'failed', failReason: 'interrupted' });
  });

  it('paginates the sent log with before', async () => {
    for (const body of ['one', 'two', 'three']) {
      ok(await owner().post('/messages', { recipientId: club.players[0]!.userId, body }));
      env.clock.advance(MIN);
    }
    const first = ok(await owner().get('/messages/sent?limit=2'));
    expect(first.messages.map((m: { body: string }) => m.body)).toEqual(['three', 'two']);
    expect(first.hasMore).toBe(true);
    const next = ok(await owner().get(`/messages/sent?limit=2&before=${encodeURIComponent(first.messages[1].createdAt)}`));
    expect(next.messages.map((m: { body: string }) => m.body)).toEqual(['one']);
    expect(next.hasMore).toBe(false);
    expect(errCode(await owner().get('/messages/sent?limit=500'))).toBe('validation.invalid');
  });
});
