// Storage: the SQLite engine that ships with Node (node:sqlite). One file, no server to run.
// All money writes happen inside tx(), so a crash never leaves half a settlement behind.

import { DatabaseSync } from 'node:sqlite';

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

export class Db {
  readonly sql: DatabaseSync;
  private depth = 0;

  constructor(file = ':memory:') {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
  }

  get<T = Row>(query: string, ...params: any[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  all<T = Row>(query: string, ...params: any[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  run(query: string, ...params: any[]) {
    return this.sql.prepare(query).run(...params);
  }

  // Nested calls become savepoints, so a service can call another service inside its own tx.
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.sql.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.sql.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.sql.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close() {
    this.sql.close();
  }
}
