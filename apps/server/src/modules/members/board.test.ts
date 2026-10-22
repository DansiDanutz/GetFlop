import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type Agent, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

interface Evening { clubId: string; owner: Agent; dealer: Agent; alice: Agent; bob: Agent; tableId: string }

/** Alice wins Rainbow on hand 1; Bob loses Any Pair on hands 1 and 2. */
async function evening(): Promise<Evening> {
  const { clubId, owner, players: [dealer, alice, bob] } = await setupClub(env, { players: ['dealer', 'alice', 'bob'], pointsEach: 50 });
  await grantRole(env, clubId, dealer!.userId, 'dealer');
  const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'T1' }));
  ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({ dealerId: dealer!.userId }));
  ok(await dealer!.post(`/api/dealer/table/${table.id}/start-hand`));
  ok(await alice!.post('/api/player/coupon').send({ tableId: table.id, rounds: 1, selections: [{ market: 'rainbow', stakeCents: 200 }] }));
  ok(await bob!.post('/api/player/coupon').send({ tableId: table.id, rounds: 2, selections: [{ market: 'any-pair', stakeCents: 100 }] }));
  ok(await dealer!.post(`/api/dealer/table/${table.id}/enter-flop`).send({ card1: 'Qc', card2: '7h', card3: '3s' }));
  ok(await dealer!.post(`/api/dealer/table/${table.id}/start-hand`));
  ok(await dealer!.post(`/api/dealer/table/${table.id}/enter-flop`).send({ card1: 'Kc', card2: '8h', card3: '4s' }));
  return { clubId, owner, dealer: dealer!, alice: alice!, bob: bob!, tableId: table.id };
}

describe('club board', () => {
  it('stays hidden from players until turned on, with a preview for managers', async () => {
    const { clubId, owner, alice } = await evening();
    expect(ok(await alice.get(`/api/clubs/${clubId}/board`))).toMatchObject({ enabled: false, top: [] });
    const preview = ok(await owner.get(`/api/clubs/${clubId}/board`));
    expect(preview).toMatchObject({ enabled: false, preview: true });
    expect(preview.top.length).toBe(2);
  });

  it('ranks by net result or flops, hides names on request, and shows the best moment', async () => {
    const { clubId, owner, alice, bob } = await evening();
    ok(await owner.put(`/api/clubs/${clubId}/settings`).send({ boardEnabled: true }));
    const net = ok(await alice.get(`/api/clubs/${clubId}/board?period=week&metric=net&tz=Europe/Athens`));
    expect(net).toMatchObject({ enabled: true, preview: false, period: 'week', metric: 'net' });
    expect(net.top.map((r: { name: string; value: number; me: boolean }) => [r.name, r.value, r.me]))
      .toEqual([['alice', 260, true], ['bob', -200, false]]);
    expect(net.me).toMatchObject({ rank: 1, value: 260, hidden: false });
    expect(net.bestMoment).toMatchObject({ name: 'alice', betTypeSlug: 'rainbow', payoutOdds: 1.3 });
    expect(new Date(net.closesAt).getTime()).toBeGreaterThan(env.clock.now().getTime());

    const flops = ok(await bob.get(`/api/clubs/${clubId}/board?metric=flops&period=month`));
    expect(flops.top.map((r: { name: string; value: number }) => [r.name, r.value])).toEqual([['bob', 2], ['alice', 1]]);

    ok(await alice.post(`/api/clubs/${clubId}/board/hidden`).send({ hidden: true }));
    const seenByBob = ok(await bob.get(`/api/clubs/${clubId}/board`));
    expect(seenByBob.top[0]).toMatchObject({ rank: 1, name: null, me: false });
    expect(seenByBob.bestMoment.name).toBeNull();
    expect(ok(await alice.get(`/api/clubs/${clubId}/board`)).me.hidden).toBe(true);
    expect(errCode(await alice.get(`/api/clubs/${clubId}/board?period=year`))).toBe('validation.invalid');
  });

  it('shows the place and balance bar', async () => {
    const { clubId, owner, alice } = await evening();
    ok(await owner.put(`/api/clubs/${clubId}/settings`).send({ boardEnabled: true }));
    ok(await alice.post('/api/player/reload-request').send({ amount: 10 }));
    const bar = ok(await alice.get(`/api/clubs/${clubId}/bar`));
    expect(bar).toMatchObject({ board: { rank: 1 }, balanceCents: 5_000 - 200 + 460, pendingRequest: { kind: 'load', amountCents: 1_000 } });
  });

  it('refuses non-members', async () => {
    const { clubId } = await evening();
    const outsider = await env.login('outsider');
    expect(errCode(await outsider.get(`/api/clubs/${clubId}/board`))).toBe('club.access_denied');
    expect(errCode(await outsider.get(`/api/clubs/${clubId}/medals`))).toBe('club.access_denied');
  });
});

describe('club medals', () => {
  it('tracks flops, tables, tournaments and weeks with progress', async () => {
    const { clubId, bob, alice } = await evening();
    const { medals } = ok(await bob.get(`/api/clubs/${clubId}/medals`));
    const byCode = Object.fromEntries(medals.map((m: { code: string }) => [m.code, m]));
    expect(Object.keys(byCode)).toEqual(['first_flop', 'flops_10', 'flops_100', 'every_table', 'first_tournament', 'four_weeks']);
    expect(byCode.first_flop).toMatchObject({ earned: true, progress: 1, target: 1 });
    expect(byCode.flops_10).toMatchObject({ earned: false, progress: 2, target: 10, remaining: 8 });
    expect(byCode.every_table).toMatchObject({ earned: true, progress: 1, target: 1 });
    expect(byCode.first_tournament).toMatchObject({ earned: false });
    expect(byCode.four_weeks).toMatchObject({ earned: false, progress: 1, target: 4, remaining: 3 });
    const aliceMedals = ok(await alice.get(`/api/clubs/${clubId}/medals`)).medals;
    expect(aliceMedals[1]).toMatchObject({ progress: 1, remaining: 9 });
  });
});

describe('onboarding', () => {
  it('remembers the intro steps a user has seen', async () => {
    const { owner } = await setupClub(env, { players: [], pointsEach: 0 });
    expect(ok(await owner.get('/api/clubs/onboarding'))).toEqual({
      scenarios: { player: [], dealer: [], inspector: [], manager: [], owner: [] }, staff: true,
    });
    ok(await owner.post('/api/clubs/onboarding/seen').send({ code: 'hello', scenario: 'owner' }));
    ok(await owner.post('/api/clubs/onboarding/seen').send({ code: 'hello', scenario: 'owner' }));
    expect(ok(await owner.get('/api/clubs/onboarding')).scenarios.owner).toEqual(['hello']);
    expect(errCode(await owner.post('/api/clubs/onboarding/seen').send({ code: 'x', scenario: 'boss' }))).toBe('validation.invalid');
  });
});
