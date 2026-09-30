// Local demo: fresh in-memory database with staff, one table, one house operator (transfer wallet)
// and a funded player. Prints the links to open. Nothing is kept after you stop it.

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 4000);
const app = createApp({ dbFile: ':memory:', publicUrl: `http://localhost:${port}` });
const { accounts, game } = app;

accounts.createStaff('admin', 'admin-demo-pass', 'admin', 'system');
accounts.createStaff('dealer', 'dealer-demo-pass', 'dealer', 'system');
accounts.createStaff('floor', 'floor-demo-pass', 'supervisor', 'system');
const table = game.createTable({ name: 'Table 1 · NLH 2/5', bettingSeconds: 60 }, 'system');
const op = accounts.createOperator({ name: 'House Club', currency: 'EUR', walletMode: 'transfer', commissionBps: 0 }, 'system');
const opRow = accounts.operator(op.id);
const links = ['alex', 'maria'].map((name, i) => {
  const player = accounts.upsertPlayer(opRow, `demo-${name}`, name[0].toUpperCase() + name.slice(1));
  accounts.transfer(opRow, 'deposit', { playerId: `demo-${name}`, amount: 50_000, txId: `seed-${i}` });
  return `http://localhost:${port}/play.html#token=${accounts.createPlayerSession(player).token}&table=${table.id}`;
});

app.tournaments.create({
  name: "Tonight's Flop Race", strategy: 'points_race', currency: 'EUR', buyIn: 0, guaranteed: 10_000,
  rules: { startingPoints: 1000, maxBets: 100, paidPercent: 5 },
}, 'system');
const direct = accounts.registerPlayer({ username: 'demo', password: 'demo-pass', displayName: 'Demo Player' });
accounts.cashier(direct.player.id, 20_000, 'demo credit', 'system');

app.startBackground();
app.server.listen(port, () => {
  console.log(`
GetFlop demo running on http://localhost:${port}

  Player "Alex"  (500.00 EUR): ${links[0]}
  Player "Maria" (500.00 EUR): ${links[1]}
  Sign-up player: http://localhost:${port}/   demo / demo-pass (200.00 EUR)   or create your own account
  Dealer console: http://localhost:${port}/dealer.html   dealer / dealer-demo-pass
  Supervisor:                                           floor / floor-demo-pass (can void rounds)
  Admin:          http://localhost:${port}/admin.html    admin / admin-demo-pass

Operator API credentials for "House Club":
  apiKey ${op.apiKey}
  secret ${op.secret}
`);
});
process.on('SIGINT', () => { app.stop(); process.exit(0); });
