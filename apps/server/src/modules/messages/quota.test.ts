import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupClub, grantRole, type ClubFixture } from '../../test/fixtures.js';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { broadcastQuota } from './quota.js';
import { scoped } from './test-helpers.js';

// A Level catalogue that defines a broadcast quota (the default one does not yet).
vi.mock('../commerce/levels.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../commerce/levels.js')>();
  return {
    ...original,
    levelOf: (code: string) => ({ ...original.levelOf(code), broadcasts: code === 'starter' ? 1 : undefined }),
  };
});

let env: TestEnv;
let club: ClubFixture;
const DAY = 86_400_000;

beforeEach(async () => {
  env = await createTestEnv();
  club = await setupClub(env, { players: ['alice', 'bob'], pointsEach: 0 });
});
afterEach(async () => { await env.close(); });

describe('broadcast quota', () => {
  it('is unlimited during the free period and for Levels without a quota', () => {
    expect(broadcastQuota('starter', new Date('2026-11-30T21:59:59Z'))).toBeNull();
    expect(broadcastQuota('starter', new Date('2026-12-01T00:00:00Z'))).toBe(1);
    expect(broadcastQuota('club100', new Date('2026-12-15T00:00:00Z'))).toBeNull();
  });

  it('is free before 1 December 2026', async () => {
    ok(await scoped(club.owner, club.clubId).post('/messages', { audience: 'all', body: 'One' }));
    env.clock.advance(DAY + 1);
    ok(await scoped(club.owner, club.clubId).post('/messages', { audience: 'all', body: 'Two' }));
  });

  it('applies the Level quota per month after the free period, with owner and staff variants', async () => {
    env.clock.advance(70 * DAY); // 2026-12-03 (sessions last 30 days: sign in again)
    const owner = await env.login('owner');
    const [alice, bob] = [await env.login('alice'), await env.login('bob')];
    ok(await scoped(owner, club.clubId).post('/messages', { audience: 'all', body: 'December news' }));
    const over = await scoped(owner, club.clubId).post('/messages', { audience: 'all', body: 'More' });
    expect(errCode(over)).toBe('commerce.capacity_broadcasts_billing');
    expect(over.body.error.params).toMatchObject({ used: 1, limit: 1, nextLevel: 'Club 100' });
    expect(over.body.error.params.resetDate).toBe('2027-01-01');

    await grantRole(env, club.clubId, alice.userId, 'manager');
    const staff = await scoped(alice, club.clubId).post('/messages', { audience: 'all', body: 'More' });
    expect(errCode(staff)).toBe('commerce.capacity_broadcasts_staff');

    // Direct messages are not promotional.
    ok(await scoped(owner, club.clubId).post('/messages', { recipientId: bob.userId, body: 'Direct' }));
    // A scheduled message for next month counts against next month.
    ok(await scoped(owner, club.clubId).post('/messages', { audience: 'all', body: 'January', sendAt: '2027-01-01T10:00:00Z' }));
  });
});
