import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, ok, type TestEnv } from '../../test/harness.js';
import { grantRole } from '../../test/fixtures.js';
import { coupon, openFloor, playHand, setClubSettings, syncClock } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 0 }); syncClock(env); });
afterEach(async () => { await env.close(); });

describe('Reports → Live', () => {
  it('lists the coupons of the window with totals and the wins / big filters', async () => {
    const f = await openFloor(env);
    await setClubSettings(env, f.clubId, { liveBigPoints: 3 });
    await playHand(f, ['Qc', '7h', '3s'], async () => {
      ok(await f.alice.post('/api/player/coupon').send(coupon(f.tableId, 'rainbow', 200)));
      ok(await f.bob.post('/api/player/coupon').send(coupon(f.tableId, 'any-pair', 100)));
    });
    ok(await f.bob.post('/api/player/coupon').send(coupon(f.tableId, 'has-ace', 100, 5)));

    const all = ok(await f.owner.get('/api/inspector/live/bets'));
    expect(all.window).toMatchObject({ kind: 'today', number: null });
    expect(all.totals).toEqual({ stakedCents: 300, paidCents: 460, clubCents: -160 });
    expect(all.bigThresholdCents).toBe(300);
    expect(all.rows.map((r: { player: string; outcome: string }) => [r.player, r.outcome])).toEqual(
      expect.arrayContaining([['alice', 'won'], ['bob', 'lost'], ['bob', 'in_progress']]),
    );
    const live = all.rows.find((r: { outcome: string }) => r.outcome === 'in_progress');
    expect(live).toMatchObject({ rounds: 5, roundsSettled: 0, committedCents: 500, isBig: true, tableName: 'Main' });

    const wins = ok(await f.owner.get('/api/inspector/live/bets?wins=1'));
    expect(wins.rows).toHaveLength(1);
    expect(wins.rows[0]).toMatchObject({ player: 'alice', wonCents: 460 });
    expect(ok(await f.owner.get('/api/inspector/live/bets?big=1')).rows.map((r: { player: string }) => r.player).sort()).toEqual(['alice', 'bob']);
    expect(ok(await f.owner.get('/api/inspector/live/bets?tableId=other')).rows).toEqual([]);

    ok(await f.owner.post('/api/inspector/session/open'));
    expect(ok(await f.owner.get('/api/inspector/live/bets')).window).toMatchObject({ kind: 'session', number: 1 });
  });

  it('lists Points movements with who moved them, filtered by staff member', async () => {
    const f = await openFloor(env);
    ok(await f.owner.post(`/api/clubs/${f.clubId}/points/mint`).send({ amount: 10, reason: 'Top up' }));
    ok(await f.alice.post('/api/player/reload-request').send({ amount: 5 }));
    const { reloads } = ok(await f.owner.get('/api/inspector/requests'));
    ok(await f.owner.post(`/api/inspector/request/${reloads[0].id}/approve`).send({}));
    ok(await f.owner.post(`/api/inspector/player/${f.bob.userId}/withdraw`).send({ amount: 2 }));

    const all = ok(await f.owner.get('/api/inspector/live/points'));
    expect(all.totals).toEqual({ givenCents: 30_000 + 500, takenCents: 200, netCents: 30_300 });
    expect(all.rows[0]).toMatchObject({ type: 'claim_back', amountCents: 200, player: 'bob', actor: 'owner', byMe: true });
    expect(all.rows.map((r: { type: string }) => r.type)).toEqual(expect.arrayContaining(['send_out', 'request', 'claim_back']));
    expect(all.staff.map((s: { name: string }) => s.name)).toEqual(['owner']);

    await grantRole(env, f.clubId, f.bob.userId, 'inspector');
    expect(ok(await f.bob.get('/api/inspector/live/points?actor=me')).rows).toEqual([]);
    expect(ok(await f.bob.get(`/api/inspector/live/points?actor=${f.owner.userId}`)).rows).toHaveLength(5);
  });
});
