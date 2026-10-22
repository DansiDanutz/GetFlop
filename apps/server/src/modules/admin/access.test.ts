import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, type TestEnv } from '../../test/harness.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

type Call = readonly ['get' | 'post' | 'put', string, Record<string, unknown>?];

const CALLS: readonly Call[] = [
  ['get', '/api/admin'],
  ['get', '/api/admin/platform'],
  ['get', '/api/admin/accounts'],
  ['get', '/api/admin/account/x'],
  ['get', '/api/admin/users'],
  ['post', '/api/admin/users', { username: 'newbie', displayName: 'N', role: 'player', pin: '1234' }],
  ['get', '/api/admin/users/x'],
  ['put', '/api/admin/users/x', { displayName: 'X' }],
  ['put', '/api/admin/users/x/toggle-active', { active: false }],
  ['put', '/api/admin/users/x/reset-pin', { newPin: '9999' }],
  ['get', '/api/admin/players/x/detail'],
  ['get', '/api/admin/live'],
  ['get', '/api/admin/tables'],
  ['get', '/api/admin/hands'],
  ['get', '/api/admin/hands/x/bets'],
  ['post', '/api/admin/bets/x/void', { reason: 'wrong cards' }],
  ['get', '/api/admin/financials/reconciliation'],
  ['get', '/api/admin/financials/daily-player-net'],
  ['get', '/api/admin/audit'],
  ['get', '/api/admin/bet-types'],
  ['put', '/api/admin/bet-types/rainbow', { payout_odds: 2 }],
  ['get', '/api/admin/more'],
  ['get', '/api/admin/more/hands'],
];

describe('admin permissions', () => {
  it('rejects a signed-in player on every admin endpoint with auth.forbidden', async () => {
    const player = await env.login('player');
    for (const [method, path, body] of CALLS) {
      const res = method === 'get' ? await player.get(path) : await player[method](path).send(body ?? {});
      expect({ path, code: errCode(res), status: res.status }).toEqual({ path, code: 'auth.forbidden', status: 403 });
    }
  });

  it('rejects anonymous callers with auth.required', async () => {
    for (const [method, path, body] of CALLS) {
      const agent = request(env.url);
      const res = method === 'get' ? await agent.get(path) : await agent[method](path).send(body ?? {});
      expect({ path, code: errCode(res) }).toEqual({ path, code: 'auth.required' });
    }
  });

  it('leaves the price untouched when a player tries to change it', async () => {
    const player = await env.login('player');
    await player.put('/api/admin/bet-types/rainbow').send({ payout_odds: 9 });
    const admin = await env.login('boss', { admin: true });
    const { betTypes } = (await admin.get('/api/admin/bet-types')).body.data;
    expect(betTypes.find((b: { slug: string }) => b.slug === 'rainbow').multiplier).toBe(2.3);
  });
});
