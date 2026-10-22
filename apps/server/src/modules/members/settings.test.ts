import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clubs, clubTables, rooms } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole, setupClub } from '../../test/fixtures.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const dataUrl = (type: string, base64: string) => `data:${type};base64,${base64}`;

async function staff() {
  const fx = await setupClub(env, { players: ['mgr', 'insp', 'pl'], pointsEach: 0 });
  const [mgr, insp, pl] = fx.players;
  await grantRole(env, fx.clubId, mgr!.userId, 'manager');
  await grantRole(env, fx.clubId, insp!.userId, 'inspector');
  return { ...fx, mgr: mgr!, insp: insp!, pl: pl! };
}

describe('club settings and profile', () => {
  it('reads settings for managers only', async () => {
    const { clubId, mgr, insp, publicId } = await staff();
    const s = ok(await mgr.get(`/api/clubs/${clubId}/settings`));
    expect(s).toMatchObject({ name: 'Sharks Imperial', publicId, dealerSitApproval: false, liveBigCents: 1_000, boardEnabled: false });
    expect(s.rooms).toHaveLength(1);
    expect(s.inviteUrl).toBe(`http://localhost:5173/c/${publicId}`);
    expect(errCode(await insp.get(`/api/clubs/${clubId}/settings`))).toBe('club.settings_forbidden');
  });

  it('saves the profile, validating name, description and photo', async () => {
    const { clubId, owner, insp } = await staff();
    const url = `/api/clubs/${clubId}/profile`;
    expect(errCode(await owner.put(url).send({ name: 'Sharks Imperial' }))).toBe('club.nothing_to_change');
    expect(errCode(await owner.put(url).send({ name: 'ab' }))).toBe('club.name_invalid');
    expect(errCode(await owner.put(url).send({ name: 'Bad <b>' }))).toBe('name.invalid_chars');
    expect(errCode(await owner.put(url).send({ description: 'x'.repeat(1_001) }))).toBe('club.description_too_long');
    expect(errCode(await owner.put(url).send({ logo: dataUrl('image/gif', PNG_1PX) }))).toBe('club.logo_invalid');
    expect(errCode(await owner.put(url).send({ logo: dataUrl('image/jpeg', PNG_1PX) }))).toBe('club.logo_invalid');
    const huge = Buffer.concat([Buffer.from(PNG_1PX, 'base64'), Buffer.alloc(300_000)]).toString('base64');
    expect(errCode(await owner.put(url).send({ logo: dataUrl('image/png', huge) }))).toBe('club.logo_too_large');
    expect(errCode(await insp.put(url).send({ name: 'New name' }))).toBe('club.settings_forbidden');
    const saved = ok(await owner.put(url).send({ name: 'Sharks Royal', description: 'Fridays', logo: dataUrl('image/png', PNG_1PX) }));
    expect(saved).toMatchObject({ name: 'Sharks Royal', description: 'Fridays', photoUrl: dataUrl('image/png', PNG_1PX) });
    expect(ok(await owner.put(url).send({ logo: null })).photoUrl).toBeNull();
    expect(env.events.named('club:context-changed').length).toBeGreaterThan(0);
  });

  it('toggles dealer sit approval and the big-pick threshold', async () => {
    const { clubId, mgr } = await staff();
    expect(ok(await mgr.put(`/api/clubs/${clubId}/dealer-sit-approval`).send({ on: true }))).toEqual({ on: true });
    expect(ok(await mgr.get(`/api/clubs/${clubId}/dealer-sit-approval`))).toEqual({ on: true });
    const [club] = await env.db.select().from(clubs).where(eq(clubs.id, clubId));
    expect(club!.dealerSitApproval).toBe(true);
    for (const bad of [0, -1, '1.234', 'abc']) {
      expect(errCode(await mgr.put(`/api/clubs/${clubId}/live-big`).send({ bigPoints: bad }))).toBe('club.live_big_invalid');
    }
    expect(ok(await mgr.put(`/api/clubs/${clubId}/live-big`).send({ bigPoints: '25.5' }))).toEqual({ bigPoints: 25.5, bigCents: 2_550 });
    expect(ok(await mgr.get(`/api/clubs/${clubId}/live-big`))).toEqual({ bigPoints: 25.5, bigCents: 2_550 });
    const s = ok(await mgr.put(`/api/clubs/${clubId}/settings`).send({ boardEnabled: true, dealerSitApproval: false }));
    expect(s).toMatchObject({ boardEnabled: true, dealerSitApproval: false, liveBigCents: 2_550 });
  });
});

describe('rooms', () => {
  it('keeps one room per club with valid, unique names', async () => {
    const { clubId, owner, insp } = await staff();
    const { rooms: list } = ok(await owner.get(`/api/clubs/${clubId}/rooms`));
    expect(list).toHaveLength(1);
    expect(errCode(await owner.post(`/api/clubs/${clubId}/rooms`).send({ name: 'x' }))).toBe('room.name_invalid');
    expect(errCode(await owner.post(`/api/clubs/${clubId}/rooms`).send({ name: 'Back room' }))).toBe('room.one_per_club');
    expect(errCode(await insp.post(`/api/clubs/${clubId}/rooms`).send({ name: 'Back room' }))).toBe('club.settings_forbidden');
    const renamed = ok(await owner.put(`/api/clubs/${clubId}/rooms/${list[0].id}`).send({ name: 'Poker room' }));
    expect(renamed.room.name).toBe('Poker room');
    expect(errCode(await owner.delete(`/api/clubs/${clubId}/rooms/${list[0].id}`))).toBe('room.last');
    expect(errCode(await owner.put(`/api/clubs/${clubId}/rooms/nope`).send({ name: 'Poker room' }))).toBe('room.not_found');
  });

  it('protects legacy extra rooms, rooms with tables and the Simulation room', async () => {
    const { clubId, owner } = await staff();
    const [main] = await env.db.select().from(rooms).where(eq(rooms.clubId, clubId));
    const [legacy] = await env.db.insert(rooms).values({ clubId, name: 'Legacy' }).returning();
    const [sim] = await env.db.insert(rooms).values({ clubId, name: 'Simulation' }).returning();
    expect(errCode(await owner.put(`/api/clubs/${clubId}/rooms/${legacy!.id}`).send({ name: 'main ROOM' }))).toBe('room.name_taken');
    expect(errCode(await owner.put(`/api/clubs/${clubId}/rooms/${sim!.id}`).send({ name: 'Sim 2' }))).toBe('room.reserved');
    expect(errCode(await owner.delete(`/api/clubs/${clubId}/rooms/${sim!.id}`))).toBe('room.reserved');
    await env.db.insert(clubTables).values({ clubId, roomId: legacy!.id, name: 'T', limits: { minCents: 10, maxCents: 100, couponCapCents: 1000, maxRounds: 5, marketMaxCents: {} } });
    expect(errCode(await owner.delete(`/api/clubs/${clubId}/rooms/${legacy!.id}`))).toBe('room.has_tables');
    ok(await owner.delete(`/api/clubs/${clubId}/rooms/${main!.id}`));
    expect(errCode(await owner.delete(`/api/clubs/${clubId}/rooms/${legacy!.id}`))).toBe('room.has_tables');
  });
});

describe('setup checklist', () => {
  it('ticks each step when it is done', async () => {
    const { clubId, owner, insp } = await setupClub(env, { players: ['insp'], pointsEach: 0 }).then(async (fx) => {
      await grantRole(env, fx.clubId, fx.players[0]!.userId, 'inspector');
      return { ...fx, insp: fx.players[0]! };
    });
    const done = async () => {
      const { setup } = ok(await insp.get(`/api/clubs/${clubId}/setup`));
      return Object.fromEntries(setup.steps.map((s: { key: string; done: boolean }) => [s.key, s.done]));
    };
    const first = ok(await owner.get(`/api/clubs/${clubId}/setup`)).setup;
    expect(first).toMatchObject({ complete: false, total: 5 });
    expect(first.steps.map((s: { key: string }) => s.key)).toEqual(['photo', 'table', 'dealer', 'players', 'points', 'level']);
    expect(first.steps.at(-1)).toMatchObject({ key: 'level', optional: true });
    expect(await done()).toMatchObject({ photo: false, table: false, dealer: false, players: true, points: false });

    ok(await owner.put(`/api/clubs/${clubId}/profile`).send({ logo: dataUrl('image/png', PNG_1PX) }));
    ok(await owner.post(`/api/clubs/${clubId}/members/${owner.userId}/roles/dealer`).send({}));
    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'T1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({}));
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 10, reason: 'Start' }));
    ok(await owner.post(`/api/inspector/player/${insp.userId}/load`).send({ amount: 1 }));
    const last = ok(await owner.get(`/api/clubs/${clubId}/setup`)).setup;
    expect(last).toMatchObject({ complete: true, done: 5 });
    expect(errCode(await (await env.login('outsider')).get(`/api/clubs/${clubId}/setup`))).toBe('club.access_denied');
  });

  it('counts a shared invite as the players step', async () => {
    const { clubId, owner } = await setupClub(env, { players: [], pointsEach: 0 });
    const players = async () => ok(await owner.get(`/api/clubs/${clubId}/setup`)).setup.steps.find((s: { key: string }) => s.key === 'players').done;
    expect(await players()).toBe(false);
    ok(await owner.post(`/api/clubs/${clubId}/invite/shared`).send({}));
    expect(await players()).toBe(true);
    const invite = ok(await owner.get(`/api/clubs/${clubId}/invite`));
    expect(invite.url).toMatch(/\/c\/\d{7}$/);
  });
});

describe('delete the club', () => {
  it('lists blockers and refuses while anything is live', async () => {
    const { clubId, owner, mgr } = await staff();
    const { table } = ok(await owner.post('/api/inspector/table').send({ name: 'T1' }));
    ok(await owner.put(`/api/inspector/table/${table.id}/open`).send({}));
    expect(errCode(await mgr.get(`/api/clubs/${clubId}/delete-check`))).toBe('club.delete_owner_only');
    const check = ok(await owner.get(`/api/clubs/${clubId}/delete-check`));
    expect(check.blockers).toMatchObject({ openTables: 1, tournaments: 0, requests: 0, returns: 0, seatedDealers: 0, liveCoupons: 0 });
    expect(check).toMatchObject({ members: 4, pointsCents: 0, diamonds: 0, restoreDays: 30 });
    const url = `/api/clubs/${clubId}/delete`;
    expect(errCode(await mgr.post(url).send({ confirmName: 'Sharks Imperial', reason: 'x' }))).toBe('club.delete_owner_only');
    expect(errCode(await owner.post(url).send({ confirmName: 'Sharks', reason: 'x' }))).toBe('club.delete_name_mismatch');
    expect(errCode(await owner.post(url).send({ confirmName: 'Sharks Imperial', reason: ' ' }))).toBe('club.delete_reason_required');
    const blocked = await owner.post(url).send({ confirmName: 'Sharks Imperial', reason: 'Closing' });
    expect(errCode(blocked)).toBe('club.delete_blocked');
    expect(blocked.body.error.params).toMatchObject({ openTables: 1 });
  });

  it('ends every membership, returns wallets to the pool and notifies members', async () => {
    const { clubId, owner, players: [pl] } = await setupClub(env, { pointsEach: 20 });
    ok(await owner.post(`/api/clubs/${clubId}/delete`).send({ confirmName: 'Sharks Imperial', reason: 'Closing down' }));
    const [club] = await env.db.select().from(clubs).where(eq(clubs.id, clubId));
    expect(club!.status).toBe('deleted');
    expect(ok(await pl!.get('/api/clubs/mine')).clubs).toEqual([]);
    const { notices } = ok(await pl!.get('/api/clubs/notices'));
    expect(notices[0]).toMatchObject({ code: 'club.deleted', params: { club: 'Sharks Imperial' } });
    ok(await pl!.post(`/api/clubs/notices/${notices[0].id}/read`).send({}));
    expect(ok(await pl!.get('/api/clubs/notices')).notices).toEqual([]);
    expect(env.events.named('club:membership-changed').at(-1)).toMatchObject({ payload: { status: 'removed', clubId } });
  });
});
