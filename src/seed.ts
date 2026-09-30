// Demo data: staff accounts, a table, a house operator with two funded players, a free
// tournament and a sign-up style player. Used by `npm run demo` and by demo deployments.

import type { App } from './app.ts';

export const DEMO_STAFF = [
  { role: 'admin', username: 'admin', password: 'admin-demo-pass' },
  { role: 'dealer', username: 'dealer', password: 'dealer-demo-pass' },
  { role: 'supervisor', username: 'floor', password: 'floor-demo-pass' },
] as const;

export const DEMO_SEED_LOCK = 71_003;

export async function seedDemo(app: App, publicUrl: string) {
  const { accounts, game } = app;
  for (const s of DEMO_STAFF) await accounts.createStaff(s.username, s.password, s.role, 'system');
  const table = await game.createTable({ name: 'Table 1 · NLH 2/5', bettingSeconds: 60 }, 'system');
  const op = await accounts.createOperator({ name: 'House Club', currency: 'EUR', walletMode: 'transfer', commissionBps: 0 }, 'system');
  const opRow = await accounts.operator(op.id);
  const links: string[] = [];
  for (const [i, name] of ['alex', 'maria'].entries()) {
    const player = await accounts.upsertPlayer(opRow, `demo-${name}`, name[0].toUpperCase() + name.slice(1));
    await accounts.transfer(opRow, 'deposit', { playerId: `demo-${name}`, amount: 50_000, txId: `seed-${i}` });
    links.push(`${publicUrl}/play.html#token=${(await accounts.createPlayerSession(player)).token}&table=${table.id}`);
  }
  await ensureDemoTournament(app);
  const direct = await accounts.registerPlayer({ username: 'demo', password: 'demo-pass', displayName: 'Demo Player' });
  await accounts.cashier(direct.player.id, 20_000, 'demo credit', 'system');
  return { table, op, links };
}

// A persistent demo keeps running for days: whenever no tournament is open or running, start a
// new free one so visitors always have something to join.
export async function ensureDemoTournament(app: App) {
  return app.db.tx(async () => {
    await app.db.exclusive(DEMO_SEED_LOCK);
    const live = await app.db.get(`SELECT 1 FROM tournaments WHERE status IN ('scheduled', 'running', 'finishing') LIMIT 1`);
    if (live) return false;
    await app.tournaments.create({
      name: "Tonight's Flop Race", strategy: 'points_race', currency: 'EUR', buyIn: 0, guaranteed: 10_000,
      rules: { startingPoints: 1000, maxBets: 100, paidPercent: 5 },
    }, 'system');
    return true;
  });
}

// Seeds an empty database exactly once, even when several copies of the app start together.
export async function seedDemoOnce(app: App, publicUrl: string) {
  return app.db.tx(async () => {
    await app.db.exclusive(DEMO_SEED_LOCK);
    if (await app.db.get('SELECT 1 FROM staff LIMIT 1')) return false;
    await seedDemo(app, publicUrl);
    return true;
  });
}
