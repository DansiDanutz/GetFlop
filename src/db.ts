// Storage. Two backends behind one async interface:
//   - SQLite, the engine that ships with Node (node:sqlite): one file or in memory. Local runs,
//     the Docker image and the tests.
//   - PostgreSQL through our own client (pg.ts), for shared hosted databases such as Supabase.
//     Used when DATABASE_URL is set, e.g. on Vercel where many copies of the app share one DB.
// All money writes happen inside tx(): on PostgreSQL at SERIALIZABLE isolation, retried
// automatically when two copies of the app touch the same rows at the same time.
// Queries are written once, SQLite style (? placeholders); translate() adapts them for Postgres.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { PgConnection, PgError, parseDatabaseUrl, type PgConfig } from './pg.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  wallet_mode TEXT NOT NULL CHECK (wallet_mode IN ('transfer','seamless')),
  wallet_url TEXT,
  api_key TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL,
  commission_bps INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at INTEGER NOT NULL,
  UNIQUE (operator_id, external_id)
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','dealer')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('player','staff')),
  subject_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  margin_bps INTEGER NOT NULL,
  min_stake INTEGER NOT NULL,
  max_stake INTEGER NOT NULL,
  max_bet_payout INTEGER NOT NULL,
  max_round_liability INTEGER NOT NULL,
  betting_seconds INTEGER NOT NULL,
  dual_confirm INTEGER NOT NULL DEFAULT 0,
  stream_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed','settled','void')),
  opened_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  closed_at INTEGER,
  settled_at INTEGER,
  flop TEXT,
  pending_flop TEXT,
  pending_by TEXT,
  void_reason TEXT,
  opened_by TEXT NOT NULL,
  UNIQUE (table_id, number)
);
CREATE INDEX IF NOT EXISTS rounds_by_status ON rounds (status);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  market_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake > 0),
  odds_x100 INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','open','won','lost','refunded','rejected')),
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at INTEGER NOT NULL,
  settled_at INTEGER,
  client_ref TEXT,
  UNIQUE (player_id, client_ref)
);
CREATE INDEX IF NOT EXISTS bets_by_round ON bets (round_id);
CREATE INDEX IF NOT EXISTS bets_by_operator_settled ON bets (operator_id, settled_at);

CREATE TABLE IF NOT EXISTS ledger_tx (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, ref)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  tx_id TEXT NOT NULL REFERENCES ledger_tx(id),
  account TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_account ON ledger_entries (account, currency);

CREATE TABLE IF NOT EXISTS balances (
  account TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance INTEGER NOT NULL,
  PRIMARY KEY (account, currency)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  action TEXT NOT NULL CHECK (action IN ('credit','rollback')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Players physically seated at a table see their own hole cards, so they may not bet on that
-- table's flop. A player sits at one table at a time.
CREATE TABLE IF NOT EXISTS seats (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  table_id TEXT NOT NULL REFERENCES tables(id),
  seated_at INTEGER NOT NULL,
  seated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS seats_by_table ON seats (table_id);

CREATE TABLE IF NOT EXISTS player_logins (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

-- Safer-play settings of direct players (see safer.ts). Amounts in minor units; NULL = no limit.
CREATE TABLE IF NOT EXISTS player_limits (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  loss_day INTEGER,
  loss_week INTEGER,
  deposit_week INTEGER,
  pending TEXT,
  pending_from INTEGER,
  excluded_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  rules TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','running','finishing','finished','cancelled')),
  currency TEXT NOT NULL,
  buy_in INTEGER NOT NULL,
  rake_bps INTEGER NOT NULL,
  guaranteed INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  prize_pool INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  points INTEGER NOT NULL,
  bets_used INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  rank INTEGER,
  prize INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tournament_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournament_bets (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  round_id TEXT NOT NULL REFERENCES rounds(id),
  market_id TEXT NOT NULL,
  stake INTEGER NOT NULL CHECK (stake > 0),
  odds_x100 INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','won','lost','refunded')),
  payout INTEGER NOT NULL DEFAULT 0,
  placed_at INTEGER NOT NULL,
  settled_at INTEGER,
  client_ref TEXT,
  UNIQUE (tournament_id, player_id, client_ref)
);
CREATE INDEX IF NOT EXISTS tbets_by_round ON tournament_bets (round_id, status);

-- Commission rate history, so an invoice always uses the rate that was agreed for its period.
CREATE TABLE IF NOT EXISTS commission_rates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  bps INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  set_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rates_by_operator ON commission_rates (operator_id, effective_from);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  currency TEXT NOT NULL,
  period_from INTEGER NOT NULL,
  period_to INTEGER NOT NULL,
  bets INTEGER NOT NULL,
  stakes INTEGER NOT NULL,
  payouts INTEGER NOT NULL,
  ggr INTEGER NOT NULL,
  carry_in INTEGER NOT NULL,
  commission_base INTEGER NOT NULL,
  commission_bps INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  carry_out INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type Row = Record<string, any>;
type Dialect = 'sqlite' | 'pg';

interface Driver {
  dialect: Dialect;
  query(sql: string, params: unknown[]): Promise<Row[]>;
  run(sql: string, params: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

class SqliteDriver implements Driver {
  dialect = 'sqlite' as const;
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  async query(sql: string, params: unknown[]) { return this.db.prepare(sql).all(...(params as any[])) as Row[]; }
  async run(sql: string, params: unknown[]) { return { changes: Number(this.db.prepare(sql).run(...(params as any[])).changes) }; }
  async exec(sql: string) { this.db.exec(sql); }
  async close() { this.db.close(); }
}

class PgDriver implements Driver {
  dialect = 'pg' as const;
  private conn: PgConnection | null = null;
  private config: PgConfig;
  constructor(url: string) { this.config = parseDatabaseUrl(url); }
  // Serverless functions sleep between requests; reconnect when the connection was dropped.
  private async c() {
    if (!this.conn || this.conn.isClosed) this.conn = await PgConnection.connect(this.config);
    return this.conn;
  }
  async query(sql: string, params: unknown[]) { return (await (await this.c()).query(sql, params)).rows; }
  async run(sql: string, params: unknown[]) { return { changes: (await (await this.c()).query(sql, params)).rowCount }; }
  async exec(sql: string) { await (await this.c()).exec(sql); }
  async close() { await this.conn?.close(); }
}

// SQLite-style SQL to PostgreSQL: ? -> $n placeholders (outside string literals), LIKE -> ILIKE
// (SQLite's LIKE ignores case).
function translate(sql: string): string {
  let n = 0;
  let out = '';
  let inString = false;
  for (const ch of sql) {
    if (ch === "'") inString = !inString;
    out += !inString && ch === '?' ? `$${++n}` : ch;
  }
  return out.replace(/\bLIKE\b/g, 'ILIKE');
}

function pgSchema(schema: string) {
  return schema
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'BIGINT');
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock
const MAX_TX_ATTEMPTS = 8;

export class Db {
  private driver: Driver;
  private txContext = new AsyncLocalStorage<{ depth: number }>();
  private lockTail: Promise<unknown> = Promise.resolve();

  private constructor(driver: Driver) {
    this.driver = driver;
  }

  // databaseUrl: postgres://... (PostgreSQL), otherwise a SQLite file path or ':memory:'.
  static async open(target = ':memory:'): Promise<Db> {
    const isPg = /^postgres(ql)?:\/\//.test(target);
    const db = new Db(isPg ? new PgDriver(target) : new SqliteDriver(target));
    if (isPg) {
      // Several cold-starting copies may create the schema at once; the advisory lock serialises them.
      await db.driver.exec(`BEGIN; SELECT pg_advisory_xact_lock(717171); ${pgSchema(SCHEMA)} COMMIT;`);
    } else {
      await db.driver.exec(SCHEMA);
    }
    return db;
  }

  get dialect(): Dialect {
    return this.driver.dialect;
  }

  async get<T = Row>(query: string, ...params: any[]): Promise<T | undefined> {
    return (await this.q(query, params))[0] as T | undefined;
  }

  async all<T = Row>(query: string, ...params: any[]): Promise<T[]> {
    return (await this.q(query, params)) as T[];
  }

  async run(query: string, ...params: any[]): Promise<{ changes: number }> {
    const sql = this.sqlFor(query);
    return this.inOrder(() => this.driver.run(sql, params));
  }

  // Runs fn in one transaction. Nested calls become savepoints, so a service can call another
  // service inside its own transaction. On PostgreSQL a conflicting concurrent transaction makes
  // the whole of fn run again, so fn must only touch the database (side effects go after).
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = this.txContext.getStore();
    if (ctx) {
      const sp = `sp${ctx.depth++}`;
      await this.driver.exec(`SAVEPOINT ${sp}`);
      try {
        const out = await fn();
        await this.driver.exec(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (e) {
        await this.driver.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        throw e;
      } finally {
        ctx.depth--;
      }
    }
    return this.locked(async () => {
      for (let attempt = 1; ; attempt++) {
        await this.driver.exec(this.driver.dialect === 'pg' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN IMMEDIATE');
        try {
          const out = await this.txContext.run({ depth: 0 }, fn);
          await this.driver.exec('COMMIT');
          return out;
        } catch (e) {
          await this.driver.exec('ROLLBACK').catch(() => {});
          if (e instanceof PgError && RETRYABLE.has(e.code) && attempt < MAX_TX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
            continue;
          }
          throw e;
        }
      }
    });
  }

  // Inside a transaction: blocks other copies of the app from entering the same section until
  // this transaction ends (PostgreSQL advisory lock). No-op on SQLite (single process).
  async exclusive(key: number) {
    if (this.driver.dialect === 'pg') await this.get('SELECT pg_advisory_xact_lock(?)', key);
  }

  async close() {
    await this.driver.close();
  }

  private sqlFor(query: string) {
    return this.driver.dialect === 'pg' ? translate(query) : query;
  }

  private q(query: string, params: unknown[]) {
    const sql = this.sqlFor(query);
    return this.inOrder(() => this.driver.query(sql, params));
  }

  // One connection handles one thing at a time: queries outside a transaction wait for the
  // running transaction; queries inside it go straight through.
  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    return this.txContext.getStore() ? fn() : this.locked(fn);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lockTail.then(fn, fn);
    this.lockTail = run.catch(() => {});
    return run;
  }
}
