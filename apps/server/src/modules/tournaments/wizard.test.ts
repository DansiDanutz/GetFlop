import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole } from '../../test/fixtures.js';
import { create, shortEvent, tournamentWorld, wizardBody } from './testkit.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

describe('create (wizard)', () => {
  it('creates an upcoming tournament on its own tournament table with the defaults', async () => {
    const { owner, players: [alice] } = await tournamentWorld(env);
    const t = await create(owner, wizardBody());
    expect(t).toMatchObject({ status: 'upcoming', buyInCents: 500, feeCents: 50, startingStack: 1_000_000, dealing: 'auto', autoDealSeconds: 20 });
    const { tables } = ok(await owner.get('/api/inspector/tables'));
    expect(tables.find((x: { id: string }) => x.id === t.tableId)).toMatchObject({ kind: 'tournament', status: 'closed', unit: 'chips' });
    const lobby = ok(await alice!.get('/api/tournaments')).tournaments;
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toMatchObject({ id: t.id, registered: false, lateRegOpen: false });
    const detail = ok(await alice!.get(`/api/tournaments/${t.id}`));
    expect(detail.levels).toHaveLength(5);
    expect(detail.payouts.map((p: { pct: number }) => p.pct)).toEqual([50, 30, 20]);
    expect(detail.registration).toEqual({ registered: false, refundRule: 'until_start' });
    expect(env.events.named('tournament:created')).not.toHaveLength(0);
  });

  it('runs the server validation', async () => {
    const { owner } = await tournamentWorld(env);
    expect(errCode(await owner.post('/api/tournaments').send(wizardBody({ name: '' })))).toBe('trm.create_missing');
    expect(errCode(await owner.post('/api/tournaments').send(wizardBody({ dealerId: 'x' })))).toBe('trm.dealer_or_auto');
    const late = await owner.post('/api/tournaments').send(wizardBody({ lateRegEndHand: 30 }));
    expect(errCode(late)).toBe('trm.latereg_too_late');
    expect(late.body.error.params).toEqual({ hand: 30, need: 25, total: 50, pct: 50, last: 26 });
    expect(errCode(await owner.post('/api/tournaments').send(wizardBody({ payoutStructure: [60, 30] })))).toBe('trm.payouts_sum');
    expect(errCode(await owner.post('/api/tournaments').send(wizardBody({ allowedBetTypeIds: ['bogus'] })))).toBe('table.market_unknown');
  });

  it('needs a dealer who holds the dealer role', async () => {
    const { owner, dealer, players: [alice] } = await tournamentWorld(env);
    expect(errCode(await owner.post('/api/tournaments').send(shortEvent(alice!.userId)))).toBe('dealer.not_found');
    expect((await create(owner, shortEvent(dealer.userId))).dealing).toBe('dealer');
    const { dealers } = ok(await owner.get('/api/tournaments/dealers/list'));
    expect(dealers).toEqual([{ id: dealer.userId, name: 'dealer', busyElsewhere: false, tableName: null }]);
  });

  it('reuses a free tournament table but never a busy one', async () => {
    const { owner } = await tournamentWorld(env);
    const first = await create(owner, wizardBody());
    const busy = await owner.post('/api/tournaments').send(wizardBody({ tableId: first.tableId }));
    expect(errCode(busy)).toBe('trm.table_busy');
    expect(ok(await owner.get('/api/tournaments/tables/free')).tables).toEqual([]);
    ok(await owner.post(`/api/tournaments/${first.id}/cancel`));
    expect(ok(await owner.get('/api/tournaments/tables/free')).tables.map((x: { id: string }) => x.id)).toEqual([first.tableId]);
    const again = await create(owner, wizardBody({ tableId: first.tableId }));
    expect(again.tableId).toBe(first.tableId);
  });

  it('is staff-only and needs a Level with tournaments', async () => {
    const { owner, players: [alice] } = await tournamentWorld(env, ['alice'], 'starter');
    expect(errCode(await alice!.post('/api/tournaments').send(wizardBody()))).toBe('club.capability_missing');
    const res = await owner.post('/api/tournaments').send(wizardBody());
    expect(errCode(res)).toBe('commerce.level_tournaments_unavailable_billing');
    expect(res.body.error.params).toEqual({ requiredLevel: 'Club 100' });
  });

  it('lists the clubs the caller can create in', async () => {
    const { clubId, owner, players: [alice] } = await tournamentWorld(env);
    expect(ok(await owner.get('/api/tournaments/clubs/list')).clubs).toEqual([
      { id: clubId, name: 'Sharks Imperial', level: 'club100', tournamentsAllowed: 1 },
    ]);
    expect(ok(await alice!.get('/api/tournaments/clubs/list')).clubs).toEqual([]);
    await grantRole(env, clubId, alice!.userId, 'inspector');
    expect(ok(await alice!.get('/api/tournaments/clubs/list')).clubs).toHaveLength(1);
  });
});

describe('lifecycle controls', () => {
  it('pins to the top of the lobby', async () => {
    const { owner, players: [alice] } = await tournamentWorld(env);
    const a = await create(owner, wizardBody({ name: 'First' }));
    const b = await create(owner, wizardBody({ name: 'Second', scheduledAt: '2026-09-30T20:00:00Z' }));
    expect(ok(await alice!.get('/api/tournaments')).tournaments.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
    expect(ok(await owner.post(`/api/tournaments/${a.id}/pin`))).toEqual({ pinned: true });
    expect(ok(await alice!.get('/api/tournaments')).tournaments.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);
    expect(ok(await owner.post(`/api/tournaments/${a.id}/pin`))).toEqual({ pinned: false });
    expect(errCode(await alice!.post(`/api/tournaments/${a.id}/pin`))).toBe('club.capability_missing');
  });

  it('checks the Level capacity when starting', async () => {
    const { owner } = await tournamentWorld(env);
    const a = await create(owner, wizardBody({ name: 'First' }));
    const b = await create(owner, wizardBody({ name: 'Second' }));
    ok(await owner.post(`/api/tournaments/${a.id}/start`));
    const res = await owner.post(`/api/tournaments/${b.id}/start`);
    expect(errCode(res)).toBe('commerce.capacity_tournaments_billing');
    expect(res.body.error.params).toEqual({ used: 1, limit: 1, nextLevel: 'Club 500' });
    ok(await owner.post(`/api/tournaments/${a.id}/finish`));
    ok(await owner.post(`/api/tournaments/${b.id}/start`));
    const panel = ok(await owner.get('/api/inspector/tournaments'));
    expect(panel.limit).toBe(1);
    expect(panel.tournaments.map((x: { status: string }) => x.status).sort()).toEqual(['active', 'finished']);
  });

  it('starts, finishes and refuses actions in the wrong state', async () => {
    const { owner } = await tournamentWorld(env);
    const t = await create(owner, wizardBody());
    expect(errCode(await owner.post(`/api/tournaments/${t.id}/finish`))).toBe('trm.not_active');
    ok(await owner.post(`/api/tournaments/${t.id}/start`));
    expect(env.events.named('tournament:started')).not.toHaveLength(0);
    const { tables } = ok(await owner.get('/api/inspector/tables'));
    expect(tables.find((x: { id: string }) => x.id === t.tableId)).toMatchObject({ status: 'open', isAutoDeal: true });
    ok(await owner.post(`/api/tournaments/${t.id}/finish`));
    expect(errCode(await owner.post(`/api/tournaments/${t.id}/cancel`))).toBe('trm.not_active');
    expect(errCode(await owner.get('/api/tournaments/nope'))).toBe('trm.not_found');
  });
});
