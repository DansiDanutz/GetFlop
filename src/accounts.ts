// Operators (partners who bring players and pay commission), their players, staff and sessions.

import type { Db, Row } from './db.ts';
import type { Ledger } from './ledger.ts';
import type { Audit } from './audit.ts';
import type { OperatorRow } from './wallet.ts';
import type { PlayerRow } from './game.ts';
import { checkPassword, fail, hashPassword, int, newId, newSecret, optStr, safeEqual, sha256, signPayload, str } from './util.ts';

const PLAYER_SESSION_MS = 12 * 3600_000;
const STAFF_SESSION_MS = 12 * 3600_000;
const SIGNATURE_WINDOW_MS = 5 * 60_000;

export class Accounts {
  private db: Db;
  private ledger: Ledger;
  private audit: Audit;
  private now: () => number;

  constructor(db: Db, ledger: Ledger, audit: Audit, now: () => number) {
    this.db = db;
    this.ledger = ledger;
    this.audit = audit;
    this.now = now;
  }

  // ---------- operators ----------

  createOperator(input: Row, actor: string) {
    const name = str(input.name, 'name', 80);
    const currency = str(input.currency, 'currency', 3, 3).toUpperCase();
    const walletMode = input.walletMode === 'seamless' ? 'seamless' : input.walletMode === 'transfer' || input.walletMode === undefined ? 'transfer' : fail(400, 'BAD_INPUT', 'walletMode must be transfer or seamless');
    const walletUrl = optStr(input.walletUrl, 'walletUrl', 500);
    if (walletMode === 'seamless' && !walletUrl) fail(400, 'BAD_INPUT', 'walletUrl is required for a seamless wallet');
    const commissionBps = int(input.commissionBps ?? 1500, 'commissionBps', 0, 10_000);
    const id = newId('op');
    const apiKey = `gfk_${newSecret(18)}`;
    const secret = newSecret(32);
    this.db.run(
      'INSERT INTO operators (id, name, currency, wallet_mode, wallet_url, api_key, secret, commission_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, currency, walletMode, walletUrl, apiKey, secret, commissionBps, this.now(),
    );
    this.recordRate(id, commissionBps, actor);
    this.audit.log(actor, 'operator.create', { operatorId: id, name, currency, walletMode, commissionBps });
    // The secret is shown once. Afterwards only rotateSecret() can reveal a new one.
    return { ...publicOperator(this.operator(id)), apiKey, secret };
  }

  updateOperator(id: string, input: Row, actor: string) {
    const op = this.operator(id);
    const status = input.status ?? op.status;
    if (status !== 'active' && status !== 'suspended') fail(400, 'BAD_INPUT', 'status must be active or suspended');
    const commissionBps = input.commissionBps === undefined ? op.commission_bps : int(input.commissionBps, 'commissionBps', 0, 10_000);
    const walletUrl = input.walletUrl === undefined ? op.wallet_url : optStr(input.walletUrl, 'walletUrl', 500);
    this.db.run('UPDATE operators SET status = ?, commission_bps = ?, wallet_url = ? WHERE id = ?', status, commissionBps, walletUrl, id);
    if (commissionBps !== op.commission_bps) this.recordRate(id, commissionBps, actor);
    this.audit.log(actor, 'operator.update', { operatorId: id, status, commissionBps, walletUrl });
    return publicOperator(this.operator(id));
  }

  // A new rate applies from now on. Periods that already ended keep the rate they had.
  private recordRate(operatorId: string, bps: number, actor: string) {
    this.db.run('INSERT INTO commission_rates (operator_id, bps, effective_from, set_by) VALUES (?, ?, ?, ?)', operatorId, bps, this.now(), actor);
  }

  rotateSecret(id: string, actor: string) {
    this.operator(id);
    const secret = newSecret(32);
    this.db.run('UPDATE operators SET secret = ? WHERE id = ?', secret, id);
    this.audit.log(actor, 'operator.rotate_secret', { operatorId: id });
    return { ...publicOperator(this.operator(id)), secret };
  }

  operator(id: string): OperatorRow {
    return this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', id) ?? fail(404, 'OPERATOR_NOT_FOUND');
  }

  listOperators() {
    return this.db.all<OperatorRow>('SELECT * FROM operators ORDER BY created_at').map(publicOperator);
  }

  // Verifies a signed server-to-server request from an operator.
  authenticateOperator(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string): OperatorRow {
    const key = String(headers['x-api-key'] ?? '');
    const ts = String(headers['x-timestamp'] ?? '');
    const sig = String(headers['x-signature'] ?? '');
    if (!key || !ts || !sig) fail(401, 'UNSIGNED', 'x-api-key, x-timestamp and x-signature headers are required');
    const op = this.db.get<OperatorRow>('SELECT * FROM operators WHERE api_key = ?', key) ?? fail(401, 'BAD_API_KEY');
    if (!/^\d+$/.test(ts) || Math.abs(this.now() - Number(ts)) > SIGNATURE_WINDOW_MS) fail(401, 'STALE_TIMESTAMP', 'x-timestamp must be within 5 minutes (ms since epoch)');
    if (!safeEqual(signPayload(op.secret, ts, method, path, body), sig)) fail(401, 'BAD_SIGNATURE');
    if (op.status !== 'active') fail(403, 'OPERATOR_SUSPENDED');
    return op;
  }

  // ---------- players ----------

  upsertPlayer(op: OperatorRow, externalId: unknown, displayName: unknown): PlayerRow {
    const ext = str(externalId, 'playerId', 100);
    const name = optStr(displayName, 'displayName', 40) ?? `Player ${ext.slice(-4)}`;
    const existing = this.db.get<PlayerRow>('SELECT * FROM players WHERE operator_id = ? AND external_id = ?', op.id, ext);
    if (existing) {
      if (existing.display_name !== name) this.db.run('UPDATE players SET display_name = ? WHERE id = ?', name, existing.id);
      return { ...existing, display_name: name };
    }
    const id = newId('pl');
    this.db.run('INSERT INTO players (id, operator_id, external_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)', id, op.id, ext, name, this.now());
    return this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', id)!;
  }

  playerByExternal(op: OperatorRow, externalId: unknown): PlayerRow {
    return this.db.get<PlayerRow>('SELECT * FROM players WHERE operator_id = ? AND external_id = ?', op.id, str(externalId, 'playerId', 100)) ?? fail(404, 'PLAYER_NOT_FOUND');
  }

  setPlayerStatus(op: OperatorRow, externalId: unknown, status: unknown) {
    if (status !== 'active' && status !== 'blocked') fail(400, 'BAD_INPUT', 'status must be active or blocked');
    const p = this.playerByExternal(op, externalId);
    this.db.run('UPDATE players SET status = ? WHERE id = ?', status, p.id);
    this.audit.log(`operator:${op.id}`, 'player.status', { playerId: p.id, status });
    return { playerId: p.external_id, status };
  }

  // Transfer wallet: the operator moves money in and out of GetFlop. txId makes retries safe.
  transfer(op: OperatorRow, direction: 'deposit' | 'withdraw', input: Row) {
    if (op.wallet_mode !== 'transfer') fail(409, 'WRONG_WALLET_MODE', 'This operator uses a seamless wallet');
    const player = this.playerByExternal(op, input.playerId);
    const amount = int(input.amount, 'amount', 1);
    // One txId = one transfer, whatever its direction. A retry with the same details is answered
    // without moving money again; reusing the id for anything else is refused.
    const ref = `${op.id}:${str(input.txId, 'txId', 100)}`;
    const signed = direction === 'deposit' ? amount : -amount;
    // Transfers recorded before txIds were unified used the kinds 'deposit' and 'withdraw' with
    // the same ref, and then one txId could have been used once in each direction. A retry that
    // matches any of those earlier transfers is the same transfer.
    const priors = this.db.all<{ amount: number | null }>(
      `SELECT e.amount FROM ledger_tx t LEFT JOIN ledger_entries e ON e.tx_id = t.id AND e.account = ?
       WHERE t.ref = ? AND t.kind IN ('operator.transfer', 'deposit', 'withdraw')`,
      `player:${player.id}`, ref,
    );
    if (priors.length) {
      if (!priors.some((p) => p.amount === signed))
        fail(409, 'TX_ID_REUSED', 'This txId was already used for a different transfer (player, direction or amount)');
    } else {
      this.ledger.transfer('operator.transfer', ref, op.currency, `operator:${op.id}`, `player:${player.id}`, signed);
    }
    return { playerId: player.external_id, balance: this.ledger.balance(`player:${player.id}`, op.currency), currency: op.currency };
  }

  // ---------- direct players (signed up on GetFlop itself) ----------
  // They belong to the built-in "GetFlop Direct" operator, which uses a transfer wallet
  // funded through the cashier (manual today, a payment provider later).

  directOperator(currency = 'EUR'): OperatorRow {
    const existing = this.db.get<OperatorRow>("SELECT * FROM operators WHERE id = 'op_direct'");
    if (existing) return existing;
    this.db.run(
      "INSERT INTO operators (id, name, currency, wallet_mode, api_key, secret, commission_bps, created_at) VALUES ('op_direct', 'GetFlop Direct', ?, 'transfer', ?, ?, 0, ?)",
      currency, `gfk_${newSecret(18)}`, newSecret(32), this.now(),
    );
    this.recordRate('op_direct', 0, 'system');
    return this.operator('op_direct');
  }

  registerPlayer(input: Row) {
    const username = str(input.username, 'username', 24, 3).toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username)) fail(400, 'BAD_INPUT', 'username may use letters, digits, dot, dash and underscore');
    const password = str(input.password, 'password', 200, 8);
    if (this.db.get('SELECT 1 FROM player_logins WHERE username = ?', username)) fail(409, 'USERNAME_TAKEN');
    const op = this.directOperator();
    const player = this.db.tx(() => {
      const p = this.upsertPlayer(op, `u:${username}`, optStr(input.displayName, 'displayName', 40) ?? username);
      this.db.run('INSERT INTO player_logins (player_id, username, password_hash) VALUES (?, ?, ?)', p.id, username, hashPassword(password));
      return p;
    });
    this.audit.log(`player:${player.id}`, 'player.register', { username });
    return { ...this.createPlayerSession(player), player: { id: player.id, displayName: player.display_name } };
  }

  loginPlayer(input: Row) {
    const username = String(input.username ?? '').toLowerCase();
    const row = this.db.get('SELECT * FROM player_logins WHERE username = ?', username);
    if (!row || !checkPassword(String(input.password ?? ''), row.password_hash)) fail(401, 'BAD_CREDENTIALS');
    const player = this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', row!.player_id)!;
    if (player.status !== 'active') fail(403, 'PLAYER_BLOCKED');
    return { ...this.createPlayerSession(player), player: { id: player.id, displayName: player.display_name } };
  }

  // Cashier for direct players: positive amount = deposit, negative = withdrawal.
  cashier(playerId: string, amountInput: unknown, note: unknown, actor: string) {
    const player = this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', playerId) ?? fail(404, 'PLAYER_NOT_FOUND');
    if (player!.operator_id !== 'op_direct') fail(409, 'NOT_DIRECT_PLAYER', "This player's money is managed by their operator");
    const amount = int(amountInput, 'amount', -1_000_000_000, 1_000_000_000);
    if (amount === 0) fail(400, 'BAD_INPUT', 'amount cannot be 0');
    const op = this.operator('op_direct');
    const why = str(note, 'note', 200);
    this.ledger.transfer(amount > 0 ? 'cashier.deposit' : 'cashier.withdraw', null, op.currency, 'house:cashier', `player:${player!.id}`, amount);
    this.audit.log(actor, 'player.cashier', { playerId, amount, note: why });
    return { playerId, balance: this.ledger.balance(`player:${player!.id}`, op.currency), currency: op.currency };
  }

  // ---------- sessions ----------

  createPlayerSession(player: PlayerRow) {
    const token = newSecret(24);
    this.db.run("INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, 'player', ?, ?)", sha256(token), player.id, this.now() + PLAYER_SESSION_MS);
    return { token, expiresAt: this.now() + PLAYER_SESSION_MS };
  }

  playerFromToken(token: string): PlayerRow {
    const s = this.session(token, 'player');
    return this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', s.subject_id) ?? fail(401, 'SESSION_EXPIRED');
  }

  createStaff(username: unknown, password: unknown, role: unknown, actor: string) {
    const u = str(username, 'username', 40, 3).toLowerCase();
    const p = str(password, 'password', 200, 10);
    if (role !== 'admin' && role !== 'supervisor' && role !== 'dealer') fail(400, 'BAD_INPUT', 'role must be admin, supervisor or dealer');
    if (this.db.get('SELECT 1 FROM staff WHERE username = ?', u)) fail(409, 'USERNAME_TAKEN');
    const id = newId('st');
    this.db.run('INSERT INTO staff (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', id, u, hashPassword(p), role, this.now());
    this.audit.log(actor, 'staff.create', { staffId: id, username: u, role });
    return { id, username: u, role };
  }

  listStaff() {
    return this.db.all('SELECT id, username, role, created_at FROM staff ORDER BY username');
  }

  staffLogin(username: unknown, password: unknown) {
    const row = this.db.get('SELECT * FROM staff WHERE username = ?', String(username ?? '').toLowerCase());
    if (!row || !checkPassword(String(password ?? ''), row.password_hash)) {
      this.audit.log('anonymous', 'staff.login_failed', { username: String(username ?? '').slice(0, 40) });
      fail(401, 'BAD_CREDENTIALS');
    }
    const token = newSecret(24);
    this.db.run("INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, 'staff', ?, ?)", sha256(token), row!.id, this.now() + STAFF_SESSION_MS);
    this.audit.log(`staff:${row!.username}`, 'staff.login', {});
    return { token, user: { id: row!.id, username: row!.username, role: row!.role } };
  }

  staffFromToken(token: string) {
    const s = this.session(token, 'staff');
    return this.db.get<{ id: string; username: string; role: string }>('SELECT id, username, role FROM staff WHERE id = ?', s.subject_id) ?? fail(401, 'SESSION_EXPIRED');
  }

  logout(token: string) {
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  private session(token: string, kind: string) {
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', sha256(token), kind);
    if (!s || s.expires_at < this.now()) fail(401, 'SESSION_EXPIRED');
    return s!;
  }
}

export function publicOperator(op: OperatorRow) {
  return {
    id: op.id, name: op.name, currency: op.currency, walletMode: op.wallet_mode, walletUrl: op.wallet_url,
    apiKey: op.api_key, commissionBps: op.commission_bps, status: op.status,
  };
}
