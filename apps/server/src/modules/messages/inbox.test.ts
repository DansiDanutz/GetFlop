import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clubTables } from '../../db/schema/index.js';
import { grantRole, setupClub, type ClubFixture } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { registerTournamentSource } from './targets.js';
import { pngDataUrl, scoped, seedCoupon, seedTable } from './test-helpers.js';

let env: TestEnv;
let club: ClubFixture;
const HOUR = 3_600_000;

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: ['alice', 'bob', 'carol'], pointsEach: 0 });
});
afterEach(async () => {
  registerTournamentSource(null);
  await env.close();
});

const owner = () => scoped(club.owner, club.clubId);
const as = (i: number) => scoped(club.players[i]!, club.clubId);

describe('player inbox, photo cards and stats', () => {
  it('shows a photo message once as a card and serves the photo to recipients and staff only', async () => {
    const photo = pngDataUrl();
    const { id } = ok(await owner().post('/messages', { audience: 'all', title: 'New felt', body: 'Come and see', photo }));
    const { cards } = ok(await as(0).get('/messages/cards'));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id, hasPhoto: true, title: 'New felt' });
    expect(ok(await as(0).get(`/messages/${id}/photo`))).toEqual({ photo });

    ok(await as(0).post(`/messages/${id}/card-shown`));
    ok(await as(0).post(`/messages/${id}/card-shown`));
    expect(ok(await as(0).get('/messages/cards')).cards).toHaveLength(0);
    // Reading in the inbox also retires the card.
    ok(await as(1).post('/messages/read-all'));
    expect(ok(await as(1).get('/messages/cards')).cards).toHaveLength(0);

    expect(ok(await owner().get(`/messages/${id}/photo`)).photo).toBe(photo);
    const outsider = await env.login('outsider');
    expect(errCode(await outsider.get(`/api/messages/${id}/photo`))).toBe('messages.not_found');
    expect(errCode(await outsider.post(`/api/messages/${id}/card-shown`).send({}))).toBe('messages.not_found');
    expect(errCode(await as(0).get('/messages/nope/photo'))).toBe('messages.not_found');

    const text = ok(await owner().post('/messages', { recipientId: club.players[0]!.userId, body: 'No photo' }));
    expect(ok(await as(0).get(`/messages/${text.id}/photo`))).toEqual({ photo: null });
    expect(ok(await as(0).get('/messages/cards')).cards).toHaveLength(0);
  });

  it('counts reached, opened, tapped and joined', async () => {
    const tableId = await seedTable(env, club.clubId, { name: 'Main', dealerId: club.owner.userId });
    const { id } = ok(await owner().post('/messages', { audience: 'all', body: 'Seats open', action: { type: 'table', ref: tableId } }));
    ok(await as(0).post('/messages/read-all'));

    const tap = ok(await as(0).post(`/messages/${id}/tap`));
    expect(tap).toEqual({ type: 'table', ref: tableId, clubId: club.clubId, available: true });
    ok(await as(1).post(`/messages/${id}/tap`));
    env.clock.advance(HOUR);
    await seedCoupon(env, club.clubId, tableId, club.players[0]!.userId);
    // Played, but not after tapping: not attributed.
    await seedCoupon(env, club.clubId, tableId, club.players[2]!.userId);
    // Played too late: not attributed.
    env.clock.advance(25 * HOUR);
    await seedCoupon(env, club.clubId, tableId, club.players[1]!.userId);

    const [row] = ok(await owner().get('/messages/sent')).messages;
    expect(row.stats).toEqual({ reached: 3, opened: 2, tapped: 2, joined: 1 });

    await env.db.update(clubTables).set({ status: 'closed' }).where(eq(clubTables.id, tableId));
    expect(ok(await as(2).post(`/messages/${id}/tap`)).available).toBe(false);
    const noButton = ok(await owner().post('/messages', { recipientId: club.players[0]!.userId, body: 'x' }));
    expect(errCode(await as(0).post(`/messages/${noButton.id}/tap`))).toBe('messages.action_unknown');
    expect(errCode(await as(0).post('/messages/nope/tap'))).toBe('messages.not_found');
  });

  it('attributes tournament registrations reported by the tournament module', async () => {
    registerTournamentSource({
      targets: async () => [{ id: 'trn-1', name: 'Sunday Cup', startsAt: null, status: 'upcoming' }],
      entrants: async () => [],
      registeredSince: async (_db, tournamentId, userIds) => (tournamentId === 'trn-1' ? userIds.slice(0, 1) : []),
    });
    const { id } = ok(await owner().post('/messages', { audience: 'all', body: 'Register', action: { type: 'tournament', ref: 'trn-1' } }));
    ok(await as(0).post(`/messages/${id}/tap`));
    const [row] = ok(await owner().get('/messages/sent')).messages;
    expect(row.stats).toMatchObject({ tapped: 1, joined: 1 });
    expect(row.action).toEqual({ type: 'tournament', ref: 'trn-1', label: 'Sunday Cup' });
  });

  it('only shows messages from clubs I am still in', async () => {
    const other = await setupClub(env, { owner: 'owner2', clubName: 'Other Club', players: [], pointsEach: 0 });
    ok(await owner().post('/messages', { audience: 'all', body: 'Home club' }));
    const { messages } = ok(await as(0).get('/messages'));
    expect(messages.map((m: { clubName: string }) => m.clubName)).toEqual(['Sharks Imperial']);
    expect(other.clubId).not.toBe(club.clubId);
  });
});

describe('suggestions', () => {
  it('suggests a welcome for new members and a table with a dealer; "Not now" hides it', async () => {
    const tableId = await seedTable(env, club.clubId, { name: 'Main', dealerId: club.owner.userId });
    await seedCoupon(env, club.clubId, tableId, club.players[0]!.userId);
    const { suggestions } = ok(await owner().get('/messages/suggestions?tz=Europe/Athens'));
    const keys = suggestions.map((s: { key: string }) => s.key);
    expect(keys).toEqual(['welcome', `table:${tableId}`]);
    expect(suggestions[0]).toMatchObject({ kind: 'welcome', audience: 'new_14', params: { count: 3, club: 'Sharks Imperial' } });
    expect(suggestions[1]).toMatchObject({ kind: 'table', audience: 'active_7', action: { type: 'table', ref: tableId, label: 'Main' } });

    expect(ok(await owner().post('/messages/suggestions/welcome/dismiss'))).toEqual({ key: 'welcome' });
    expect(ok(await owner().get('/messages/suggestions')).suggestions.map((s: { key: string }) => s.key)).toEqual([`table:${tableId}`]);
    expect(errCode(await owner().post('/messages/suggestions/lottery/dismiss'))).toBe('messages.suggestion_unknown');

    env.clock.advance(8 * 24 * HOUR);
    expect(ok(await owner().get('/messages/suggestions')).suggestions.map((s: { key: string }) => s.key)).toContain('welcome');
  });

  it('suggests a comeback and upcoming tournaments', async () => {
    registerTournamentSource({
      targets: async () => [
        { id: 't1', name: 'Friday Freeroll', startsAt: '2026-09-25T19:00:00.000Z', status: 'upcoming' },
        { id: 't2', name: 'Running now', startsAt: null, status: 'running' },
      ],
      entrants: async () => [club.players[1]!.userId],
      registeredSince: async () => [],
    });
    env.clock.advance(40 * 24 * HOUR);
    const owner40 = scoped(await env.login('owner'), club.clubId);
    const keys = ok(await owner40.get('/messages/suggestions')).suggestions.map((s: { key: string }) => s.key);
    expect(keys).toEqual(['comeback', 'tournament:t1']);
  });

  it('is for writers only', async () => {
    await grantRole(env, club.clubId, club.players[0]!.userId, 'inspector');
    expect(errCode(await as(0).get('/messages/suggestions'))).toBe('club.capability_missing');
  });
});
