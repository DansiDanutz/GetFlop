import { after } from 'node:test';
import { createApp, type App, type AppOptions } from '../src/app.ts';
import { signPayload } from '../src/util.ts';

// Tests run on in-memory SQLite, or on PostgreSQL when TEST_DATABASE_URL is set. Each PostgreSQL
// test gets a fresh schema-less database state by truncating every table first.
const apps: App[] = [];
after(async () => { for (const app of apps) await app.stop(); }); // PostgreSQL connections keep the process alive

export async function setup(opts: AppOptions = {}) {
  const clock = { t: Date.UTC(2026, 9, 1, 12) };
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) await resetPg(pgUrl);
  const app = await createApp({ dbFile: pgUrl || ':memory:', now: () => clock.t, log: () => {}, ...opts });
  apps.push(app);
  const admin = 'staff:admin';
  const table = await app.game.createTable({ name: 'T1', marginBps: 500, minStake: 100, maxStake: 100_000, bettingSeconds: 30 }, admin);
  const op = await app.accounts.createOperator({ name: 'Partner', currency: 'EUR', walletMode: 'transfer', commissionBps: 2000 }, admin);
  const opRow = await app.accounts.operator(op.id);
  const player = async (ext: string, deposit = 100_000) => {
    const p = await app.accounts.upsertPlayer(opRow, ext, ext);
    if (deposit) await app.accounts.transfer(opRow, 'deposit', { playerId: ext, amount: deposit, txId: `dep-${ext}` });
    return p;
  };
  const balance = (playerId: string, currency = 'EUR') => app.ledger.balance(`player:${playerId}`, currency);
  const advance = (ms: number) => { clock.t += ms; };
  return { app, clock, advance, table, op, opRow, player, balance, admin };
}

async function resetPg(url: string) {
  const { Db } = await import('../src/db.ts');
  const db = await Db.open(url);
  const tables = await db.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()");
  if (tables.length) await db.run(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await db.close();
}

// Performs a real HTTP request against the app's server (started on a random port).
export async function http(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  if (!app.server.listening) await new Promise<void>((r) => app.server.listen(0, r));
  const { port } = app.server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

export function signed(op: { apiKey: string; secret: string }, now: number, method: string, path: string, body: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(now);
  return { 'x-api-key': op.apiKey, 'x-timestamp': ts, 'x-signature': signPayload(op.secret, ts, method, path, raw) };
}
