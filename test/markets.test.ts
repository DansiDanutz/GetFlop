import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_FLOPS, flopIndex, parseCard, parseFlop, formatCard } from '../src/cards.ts';
import { MARKETS, payoutFor, priceList, priceX100 } from '../src/markets.ts';

test('there are 22,100 flops and each has a unique index', () => {
  assert.equal(ALL_FLOPS.length, 22_100);
  assert.equal(flopIndex(parseFlop(['Kd', '2c', 'Ah'])), flopIndex(parseFlop(['Ah', 'Kd', '2c'])));
  assert.equal(formatCard(parseCard('Td')), 'Td');
  assert.throws(() => parseFlop(['Ah', 'Ah', '2c']));
  assert.throws(() => parseCard('1x'));
});

test('winning flop counts match combinatorics', () => {
  const n = (id: string) => MARKETS.get(id)!.winningFlops;
  assert.equal(n('MONOTONE'), 4 * 286); // 4 suits x C(13,3)
  assert.equal(n('RAINBOW'), 4 * 13 ** 3); // pick 3 suits, one card of each
  assert.equal(n('TWO_TONE'), 22_100 - 1144 - 8788);
  assert.equal(n('TRIPS'), 13 * 4);
  assert.equal(n('PAIRED'), 13 * 6 * 48);
  assert.equal(n('NO_PAIR'), 286 * 64);
  assert.equal(n('STRAIGHT'), 12 * 64); // A23 .. QKA
  assert.equal(n('STRAIGHT_FLUSH'), 12 * 4);
  assert.equal(n('HAS_ACE'), 22_100 - 17_296); // minus C(48,3)
  assert.equal(n('ALL_RED'), 2600); // C(26,3)
  assert.equal(n('ALL_BROADWAY'), 1140); // C(20,3)
});

test('odds always keep at least the configured margin', () => {
  for (const margin of [0, 100, 300, 500, 1000]) {
    for (const m of priceList(margin)) assert.ok(m.houseEdge >= margin / 10_000 - 1e-12, `${m.id} at ${margin}`);
  }
  assert.equal(priceX100(MARKETS.get('TRIPS')!, 500), 40375);
  assert.equal(payoutFor(1000, 238), 2380);
  assert.equal(payoutFor(333, 115), 382); // rounded down
});
