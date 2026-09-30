// Demo data: staff accounts, a table, a house operator with two funded players, a free
// tournament and a sign-up style player. Used by `npm run demo` and by demo deployments.

import type { App } from './app.ts';

export const DEMO_STAFF = [
  { role: 'admin', username: 'admin', password: 'admin-demo-pass' },
  { role: 'dealer', username: 'dealer', password: 'dealer-demo-pass' },
  { role: 'supervisor', username: 'floor', password: 'floor-demo-pass' },
] as const;

export function seedDemo(app: App, publicUrl: string) {
  const { accounts, game } = app;
  for (const s of DEMO_STAFF) accounts.createStaff(s.username, s.password, s.role, 'system');
  const table = game.createTable({ name: 'Table 1 · NLH 2/5', bettingSeconds: 60 }, 'system');
  const op = accounts.createOperator({ name: 'House Club', currency: 'EUR', walletMode: 'transfer', commissionBps: 0 }, 'system');
  const opRow = accounts.operator(op.id);
  const links = ['alex', 'maria'].map((name, i) => {
    const player = accounts.upsertPlayer(opRow, `demo-${name}`, name[0].toUpperCase() + name.slice(1));
    accounts.transfer(opRow, 'deposit', { playerId: `demo-${name}`, amount: 50_000, txId: `seed-${i}` });
    return `${publicUrl}/play.html#token=${accounts.createPlayerSession(player).token}&table=${table.id}`;
  });
  app.tournaments.create({
    name: "Tonight's Flop Race", strategy: 'points_race', currency: 'EUR', buyIn: 0, guaranteed: 10_000,
    rules: { startingPoints: 1000, maxBets: 100, paidPercent: 5 },
  }, 'system');
  const direct = accounts.registerPlayer({ username: 'demo', password: 'demo-pass', displayName: 'Demo Player' });
  accounts.cashier(direct.player.id, 20_000, 'demo credit', 'system');
  return { table, op, links };
}
