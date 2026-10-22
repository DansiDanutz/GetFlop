import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { resetFlopRecognizer, setFlopRecognizer } from './scan.js';
import { dealerWorld } from './testWorld.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv({ bettingTimerSeconds: 30 }); });
afterEach(async () => { resetFlopRecognizer(); await env.close(); });

const IMAGE = Buffer.from('fake-jpeg-bytes').toString('base64');
const coupon = (tableId: string, markets: string[]) =>
  ({ tableId, rounds: 1, selections: markets.map((market) => ({ market, stakeCents: 100 })) });

async function seated() {
  const world = await dealerWorld(env);
  const tableId = world.tables[0]!;
  ok(await world.dealer.post(`/api/dealer/table/${tableId}/sit`));
  return { ...world, tableId };
}

describe('console state', () => {
  it('reports the live players and picks of the current hand', async () => {
    const { dealer, alice, owner, clubId, tableId } = await seated();
    const idle = ok(await dealer.get(`/api/dealer/table/${tableId}/current-hand`));
    expect(idle).toMatchObject({ hand: null, live: { players: 0, picks: 0 }, table: { id: tableId, name: 'Table 1' } });

    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await alice.post('/api/player/coupon').send(coupon(tableId, ['rainbow', 'any-pair'])));
    ok(await owner.post(`/api/clubs/${clubId}/points/mint`).send({ amount: 5, reason: 'Own play' }));
    ok(await owner.post(`/api/inspector/player/${owner.userId}/load`).send({ amount: 5 }));
    ok(await owner.post('/api/player/coupon').send(coupon(tableId, ['rainbow'])));
    const live = ok(await dealer.get(`/api/dealer/table/${tableId}/current-hand`));
    expect(live).toMatchObject({ hand: { handNumber: 1, status: 'betting_open' }, live: { players: 2, picks: 3 } });
    expect(live.hand.bettingClosesAt).toBeTruthy();
    expect(env.events.named('coupon:placed')).toHaveLength(2);
  });

  it('lists recent hands newest first with a limit', async () => {
    const { dealer, tableId } = await seated();
    for (let i = 0; i < 3; i++) {
      ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
      if (i === 1) ok(await dealer.post(`/api/dealer/table/${tableId}/cancel-hand`));
      else ok(await dealer.post(`/api/dealer/table/${tableId}/enter-flop`).send({ card1: 'Ah', card2: 'Kd', card3: '2c' }));
    }
    const { hands, unit } = ok(await dealer.get(`/api/dealer/table/${tableId}/hands?limit=2`));
    expect(unit).toBe('points');
    expect(hands.map((h: { handNumber: number; status: string }) => [h.handNumber, h.status])).toEqual([[3, 'settled'], [2, 'cancelled']]);
    expect(hands[0].flop).toEqual(['Ah', 'Kd', '2c']);
    expect(ok(await dealer.get(`/api/dealer/table/${tableId}/hands`)).hands).toHaveLength(3);
    expect(errCode(await dealer.get(`/api/dealer/table/${tableId}/hands?limit=abc`))).toBe('validation.invalid');
    expect(errCode(await dealer.get('/api/dealer/table/nope/hands'))).toBe('table.not_found');
  });
});

describe('scan-flop', () => {
  it('needs a closed hand at a table the caller deals', async () => {
    const { dealer, alice, tableId } = await seated();
    const scan = () => dealer.post(`/api/dealer/table/${tableId}/scan-flop`).send({ image: IMAGE, mediaType: 'image/jpeg' });
    expect(errCode(await scan())).toBe('hand.not_live');
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    expect(errCode(await scan())).toBe('dealer.table_changed');
    ok(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`));
    const res = await scan();
    expect(res.status).toBe(503);
    expect(errCode(res)).toBe('scan.unavailable');
    expect(errCode(await alice.post(`/api/dealer/table/${tableId}/scan-flop`).send({ image: IMAGE, mediaType: 'image/jpeg' })))
      .toBe('club.capability_missing');
  });

  it('validates the image', async () => {
    const { dealer, tableId } = await seated();
    const post = (body: unknown) => dealer.post(`/api/dealer/table/${tableId}/scan-flop`).send(body as object);
    expect(errCode(await post({ image: '', mediaType: 'image/jpeg' }))).toBe('validation.invalid');
    expect(errCode(await post({ image: '%%%not-base64%%%', mediaType: 'image/jpeg' }))).toBe('validation.invalid');
    expect(errCode(await post({ image: IMAGE, mediaType: 'application/pdf' }))).toBe('validation.invalid');
  });

  it('returns only valid distinct cards from the recognizer and never settles', async () => {
    const { dealer, tableId } = await seated();
    const seen: string[] = [];
    setFlopRecognizer({
      recognize: async (input) => {
        seen.push(input.mediaType, input.image.toString());
        return { cards: ['Ah', 'ah', '10d', 'Zz', 'Kc', '2s'], confidence: 'low' };
      },
    });
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`));
    const res = ok(await dealer.post(`/api/dealer/table/${tableId}/scan-flop`).send({ image: IMAGE, mediaType: 'image/jpeg' }));
    expect(res).toEqual({ cards: ['Ah', 'Td', 'Kc'], confidence: 'low' });
    expect(seen).toEqual(['image/jpeg', 'fake-jpeg-bytes']);
    expect(ok(await dealer.get(`/api/dealer/table/${tableId}/current-hand`)).hand.status).toBe('betting_closed');
  });

  it('discards the result when the hand changed during recognition', async () => {
    const { dealer, tableId } = await seated();
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`));
    setFlopRecognizer({
      recognize: async () => {
        ok(await dealer.post(`/api/dealer/table/${tableId}/cancel-hand`));
        return { cards: ['Ah', 'Kd', '2c'], confidence: 'high' };
      },
    });
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/scan-flop`).send({ image: IMAGE, mediaType: 'image/jpeg' })))
      .toBe('dealer.table_changed');
  });

  it('reports a failing recognizer as unavailable', async () => {
    const { dealer, tableId } = await seated();
    setFlopRecognizer({ recognize: async () => { throw new Error('vision down'); } });
    ok(await dealer.post(`/api/dealer/table/${tableId}/start-hand`));
    ok(await dealer.post(`/api/dealer/table/${tableId}/no-more-bets`));
    expect(errCode(await dealer.post(`/api/dealer/table/${tableId}/scan-flop`).send({ image: IMAGE, mediaType: 'image/jpeg' })))
      .toBe('scan.unavailable');
  });
});
