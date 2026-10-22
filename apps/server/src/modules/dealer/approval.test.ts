import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memberships } from '../../db/schema/index.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { grantRole } from '../../test/fixtures.js';
import { dealerWorld, secondClub } from './testWorld.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 30 }); });
afterEach(async () => { await env.close(); });

describe('sit requests when the club requires approval', () => {
  it('creates one pending request that the floor sees, and lets the dealer cancel it', async () => {
    const { dealer, floor, alice, clubId, tables: [t1, t2] } = await dealerWorld(env, { approval: true });
    const res = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    expect(res).toMatchObject({ status: 'requested', request: { tableId: t1, tableName: 'Table 1', status: 'pending' } });
    expect(env.events.named('dealer-sit:new')[0]).toMatchObject({ room: `staff:${clubId}`, payload: { sitId: res.request.id, tableId: t1 } });

    const avail = ok(await dealer.get('/api/dealer/available-tables'));
    expect(avail).toMatchObject({ needsApproval: true, pending: { id: res.request.id, tableId: t1, tableName: 'Table 1', clubName: 'Sharks Imperial' } });
    expect(errCode(await dealer.post(`/api/dealer/table/${t2}/sit`))).toBe('dealer.request_pending');
    expect(errCode(await dealer.post(`/api/dealer/table/${t1}/sit`))).toBe('dealer.request_pending');

    const requests = ok(await floor.get('/api/inspector/requests'));
    expect(requests.dealerSits).toEqual([expect.objectContaining({
      id: res.request.id, tableId: t1, tableName: 'Table 1', dealerId: dealer.userId, dealerName: 'dealer',
    })]);

    expect(errCode(await alice.post(`/api/dealer/sit-requests/${res.request.id}/cancel`))).toBe('club.request_not_found');
    ok(await dealer.post(`/api/dealer/sit-requests/${res.request.id}/cancel`));
    expect(env.events.named('dealer-sit:resolved').at(-1)!.payload).toMatchObject({ sitId: res.request.id, tableId: t1 });
    expect(errCode(await dealer.post(`/api/dealer/sit-requests/${res.request.id}/cancel`))).toBe('club.request_not_found');
    expect(ok(await floor.get('/api/inspector/requests')).dealerSits).toEqual([]);
    expect(ok(await dealer.get('/api/dealer/available-tables')).pending).toBeNull();
  });

  it('lets the owner or a manager sit without approval', async () => {
    const { owner, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    await grantRole(env, clubId, owner.userId, 'dealer');
    expect(ok(await owner.get('/api/dealer/available-tables')).needsApproval).toBe(false);
    expect(ok(await owner.post(`/api/dealer/table/${t1}/sit`)).status).toBe('seated');
  });

  it('approves: the dealer is seated and told', async () => {
    const { dealer, floor, alice, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    const { request } = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    expect(errCode(await alice.post(`/api/inspector/dealer-sit/${request.id}/approve`))).toBe('club.capability_missing');
    const done = ok(await floor.post(`/api/inspector/dealer-sit/${request.id}/approve`));
    expect(done).toMatchObject({ result: 'approved', request: { status: 'approved' } });
    expect(env.events.named('dealer:seat').at(-1)).toMatchObject({
      room: `user:${dealer.userId}`, payload: { status: 'approved', tableId: t1, tableName: 'Table 1' },
    });
    expect(env.events.named('dealer-sit:resolved').at(-1)).toMatchObject({ room: `staff:${clubId}` });
    expect(ok(await dealer.get('/api/dealer/tables')).tables[0].id).toBe(t1);
    expect(errCode(await floor.post(`/api/inspector/dealer-sit/${request.id}/approve`))).toBe('club.request_not_found');
  });

  it('rejects: the dealer is told and can ask again', async () => {
    const { dealer, floor, tables: [t1] } = await dealerWorld(env, { approval: true });
    const { request } = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    expect(ok(await floor.post(`/api/inspector/dealer-sit/${request.id}/reject`))).toMatchObject({ result: 'rejected' });
    expect(env.events.named('dealer:seat').at(-1)!.payload).toMatchObject({ status: 'rejected', tableId: t1 });
    expect(ok(await dealer.post(`/api/dealer/table/${t1}/sit`)).status).toBe('requested');
  });

  it('closes with "taken" when the table got a dealer meanwhile', async () => {
    const { dealer, floor, alice, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    const { request } = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    await grantRole(env, clubId, alice.userId, 'dealer');
    ok(await floor.post(`/api/inspector/table/${t1}/assign`).send({ dealerId: alice.userId }));
    expect(ok(await floor.post(`/api/inspector/dealer-sit/${request.id}/approve`))).toMatchObject({ result: 'taken', request: { status: 'taken' } });
    expect(env.events.named('dealer:seat').at(-1)).toMatchObject({ room: `user:${dealer.userId}`, payload: { status: 'taken', tableName: 'Table 1' } });
    expect(ok(await dealer.get('/api/dealer/available-tables')).pending).toBeNull();
  });

  it('closes with "busy" when the dealer went to another table', async () => {
    const { dealer, floor, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    const other = await secondClub(env, dealer, clubId);
    const { request } = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    ok(await dealer.post(`/api/dealer/table/${other.tableId}/sit`).set('X-Club-Id', other.clubId));
    expect(ok(await floor.post(`/api/inspector/dealer-sit/${request.id}/approve`))).toMatchObject({ result: 'busy', request: { status: 'busy' } });
    expect(ok(await dealer.get('/api/dealer/tables')).tables[0].id).toBe(other.tableId);
  });

  it('refuses approval when the member is no longer a dealer', async () => {
    const { dealer, floor, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    const { request } = ok(await dealer.post(`/api/dealer/table/${t1}/sit`));
    await env.db.update(memberships).set({ roles: [] }).where(and(eq(memberships.clubId, clubId), eq(memberships.userId, dealer.userId)));
    expect(errCode(await floor.post(`/api/inspector/dealer-sit/${request.id}/approve`))).toBe('dealer.not_found');
  });

  it('switches from a held table into a request here', async () => {
    const { dealer, clubId, tables: [t1] } = await dealerWorld(env, { approval: true });
    const other = await secondClub(env, dealer, clubId);
    ok(await dealer.post(`/api/dealer/table/${other.tableId}/sit`).set('X-Club-Id', other.clubId));
    const res = ok(await dealer.post(`/api/dealer/table/${t1}/switch`).send({ heldTableId: other.tableId }));
    expect(res).toMatchObject({ status: 'requested', request: { tableId: t1 } });
    expect(ok(await dealer.get('/api/dealer/tables')).tables).toHaveLength(0);
  });
});
