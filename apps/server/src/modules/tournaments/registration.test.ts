import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubs } from '../../db/schema/index.js';
import { addMember, grantRole } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { balance, create, dealHand, RAINBOW, shortEvent, tournamentWorld, wizardBody } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const supply = async (owner: Parameters<typeof balance>[0], clubId: string) => ok(await owner.get(`/api/clubs/${clubId}/points`));

describe('registration', () => {
  it('takes buy-in + fee through the ledger and refunds it in full on unregister', async () => {
    const { clubId, owner, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, wizardBody());
    const res = ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    expect(res).toMatchObject({ registered: true, status: 'registered', paidCents: 550, refundRule: 'until_start' });
    expect(await balance(alice!)).toBe(10_000 - 550);
    expect(await supply(owner, clubId)).toMatchObject({ inTournaments: 500, drift: 0 });
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/register`))).toBe('trm.already_registered');
    expect(env.events.named('tournament:registered')).not.toHaveLength(0);

    expect(ok(await alice!.post(`/api/tournaments/${t.id}/unregister`))).toEqual({ unregistered: true, refundedCents: 550 });
    expect(await balance(alice!)).toBe(10_000);
    expect(await supply(owner, clubId)).toMatchObject({ inTournaments: 0, drift: 0 });
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/unregister`))).toBe('trm.not_registered');

    ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    expect(ok(await alice!.get(`/api/tournaments/${t.id}`)).tournament).toMatchObject({ entrants: 1, poolCents: 500 });
  });

  it('refuses without enough Points, without a wallet and for staff', async () => {
    const { clubId, owner, dealer, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, wizardBody({ buyInCents: 20_000 }));
    const res = await alice!.post(`/api/tournaments/${t.id}/register`);
    expect(errCode(res)).toBe('trm.insufficient_balance');
    expect(res.body.error.params).toEqual({ amount: 20_050 });
    const dave = await env.login('dave');
    await addMember(env, owner, clubId, dave);
    expect(errCode(await dave.post(`/api/tournaments/${t.id}/register`))).toBe('trm.no_wallet');
    expect(errCode(await dealer.post(`/api/tournaments/${t.id}/register`))).toBe('club.play_staff');
    await grantRole(env, clubId, alice!.userId, 'inspector');
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/register`))).toBe('club.play_staff');
  });

  it('allows free entry', async () => {
    const { owner, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, wizardBody({ buyInCents: 0, feeCents: 0 }));
    expect(ok(await alice!.post(`/api/tournaments/${t.id}/register`)).paidCents).toBe(0);
    expect(await balance(alice!)).toBe(10_000);
  });

  it('closes unregistering one minute before an automatic start, and at the start', async () => {
    const { owner, players: [alice, bob] } = await tournamentWorld(env);
    const at = new Date(env.clock.now().getTime() + 5 * 60_000).toISOString();
    const t = await create(owner, wizardBody({ autoStart: true, scheduledAt: at }));
    expect(ok(await alice!.post(`/api/tournaments/${t.id}/register`)).refundRule).toBe('until_cutoff');
    ok(await bob!.post(`/api/tournaments/${t.id}/register`));
    env.clock.advance(4.5 * 60_000);
    const res = await alice!.post(`/api/tournaments/${t.id}/unregister`);
    expect(errCode(res)).toBe('trm.unregister_cutoff');
    expect(res.body.error.params).toEqual({ minutes: 1 });
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    expect(errCode(await bob!.post(`/api/tournaments/${t.id}/unregister`))).toBe('trm.unregister_started');
  });

  it('refunds every entry, rebuy included, when cancelled', async () => {
    const { clubId, owner, dealer, players: [alice, bob] } = await tournamentWorld(env);
    const t = await create(owner, shortEvent(dealer.userId, { allowRebuys: true, rebuyEndHand: 3, startingStack: 10_000, rebuyStack: 10_000 }));
    ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    ok(await bob!.post(`/api/tournaments/${t.id}/register`));
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    // Alice loses her whole stack on hand 1 (paired flop), then rebuys.
    await dealHand(dealer, t.tableId, ['7h', '7d', '2h'], async () => {
      ok(await alice!.post('/api/player/coupon').send({ tableId: t.tableId, rounds: 1, selections: [{ market: 'rainbow', stakeCents: 10_000 }] }));
    });
    expect(ok(await alice!.post(`/api/tournaments/${t.id}/rebuy`))).toEqual({ chips: 10_000, rebuys: 1 });
    expect(await balance(alice!)).toBe(10_000 - 550 - 500);
    const res = ok(await owner.post(`/api/tournaments/${t.id}/cancel`));
    expect(res.refundedCents).toBe(550 + 500 + 550);
    expect(await balance(alice!)).toBe(10_000);
    expect(await balance(bob!)).toBe(10_000);
    expect(await supply(owner, clubId)).toMatchObject({ inTournaments: 0, drift: 0, riding: 0 });
    expect(env.events.named('tournament:cancelled')).not.toHaveLength(0);
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/register`))).toBe('trm.registration_closed');
  });

  it('keeps late registration open until its hand, with a full stack', async () => {
    const { owner, dealer, players: [alice, bob, carol] } = await tournamentWorld(env);
    const t = await create(owner, shortEvent(dealer.userId, { allowLateRegistration: true, lateRegEndHand: 2 }));
    ok(await alice!.post(`/api/tournaments/${t.id}/register`));
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    const late = ok(await bob!.post(`/api/tournaments/${t.id}/register`));
    expect(late).toMatchObject({ status: 'active', chips: 1_000_000, refundRule: 'final' });
    expect(errCode(await bob!.post(`/api/tournaments/${t.id}/unregister`))).toBe('trm.unregister_started');
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(ok(await carol!.get('/api/tournaments')).tournaments[0].lateRegOpen).toBe(true);
    await dealHand(dealer, t.tableId, RAINBOW);
    expect(errCode(await carol!.post(`/api/tournaments/${t.id}/register`))).toBe('trm.registration_closed');
  });

  it('closes registration at the start when late registration is off', async () => {
    const { owner, dealer, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, shortEvent(dealer.userId));
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/register`))).toBe('trm.registration_closed');
  });

  it('is unavailable when the club Level drops below tournaments', async () => {
    const { clubId, owner, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, wizardBody());
    await env.db.update(clubs).set({ level: 'starter' }).where(eq(clubs.id, clubId));
    expect(errCode(await alice!.post(`/api/tournaments/${t.id}/register`))).toBe('commerce.tournament_unavailable');
  });
});
