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

  async createOperator(input: Row, actor: string) {
    const name = str(input.name, 'name', 80);
    const currency = str(input.currency, 'currency', 3, 3).toUpperCase();
    const walletMode = input.walletMode === 'seamless' ? 'seamless' : input.walletMode === 'transfer' || input.walletMode === undefined ? 'transfer' : fail(400, 'BAD_INPUT', 'walletMode must be transfer or seamless');
    const walletUrl = optStr(input.walletUrl, 'walletUrl', 500);
    if (walletMode === 'seamless' && !walletUrl) fail(400, 'BAD_INPUT', 'walletUrl is required for a seamless wallet');
    const commissionBps = int(input.commissionBps ?? 1500, 'commissionBps', 0, 10_000);
    const id = newId('op');
    const apiKey = `gfk_${newSecret(18)}`;
    const secret = newSecret(32);
    await this.db.tx(async () => {
      await this.db.run(
        'INSERT INTO operators (id, name, currency, wallet_mode, wallet_url, api_key, secret, commission_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, name, currency, walletMode, walletUrl, apiKey, secret, commissionBps, this.now(),
      );
      await this.recordRate(id, commissionBps, actor);
      await this.audit.log(actor, 'operator.create', { operatorId: id, name, currency, walletMode, commissionBps });
    });
    // The secret is shown once. Afterwards only rotateSecret() can reveal a new one.
    return { ...publicOperator(await this.operator(id)), apiKey, secret };
  }

  async updateOperator(id: string, input: Row, actor: string) {
    await this.db.tx(async () => {
      const op = await this.operator(id);
      const status = input.status ?? op.status;
      if (status !== 'active' && status !== 'suspended') fail(400, 'BAD_INPUT', 'status must be active or suspended');
      const commissionBps = input.commissionBps === undefined ? op.commission_bps : int(input.commissionBps, 'commissionBps', 0, 10_000);
      const walletUrl = input.walletUrl === undefined ? op.wallet_url : optStr(input.walletUrl, 'walletUrl', 500);
      await this.db.run('UPDATE operators SET status = ?, commission_bps = ?, wallet_url = ? WHERE id = ?', status, commissionBps, walletUrl, id);
      if (commissionBps !== op.commission_bps) await this.recordRate(id, commissionBps, actor);
      await this.audit.log(actor, 'operator.update', { operatorId: id, status, commissionBps, walletUrl });
    });
    return publicOperator(await this.operator(id));
  }

  // A new rate applies from now on. Periods that already ended keep the rate they had.
  private async recordRate(operatorId: string, bps: number, actor: string) {
    await this.db.run('INSERT INTO commission_rates (operator_id, bps, effective_from, set_by) VALUES (?, ?, ?, ?)', operatorId, bps, this.now(), actor);
  }

  async rotateSecret(id: string, actor: string) {
    await this.operator(id);
    const secret = newSecret(32);
    await this.db.tx(async () => {
      await this.db.run('UPDATE operators SET secret = ? WHERE id = ?', secret, id);
      await this.audit.log(actor, 'operator.rotate_secret', { operatorId: id });
    });
    return { ...publicOperator(await this.operator(id)), secret };
  }

  async operator(id: string): Promise<OperatorRow> {
    return (await this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', id)) ?? fail(404, 'OPERATOR_NOT_FOUND');
  }

  async listOperators() {
    return (await this.db.all<OperatorRow>('SELECT * FROM operators ORDER BY created_at')).map(publicOperator);
  }

  // Verifies a signed server-to-server request from an operator.
  async authenticateOperator(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string): Promise<OperatorRow> {
    const key = String(headers['x-api-key'] ?? '');
    const ts = String(headers['x-timestamp'] ?? '');
    const sig = String(headers['x-signature'] ?? '');
    if (!key || !ts || !sig) fail(401, 'UNSIGNED', 'x-api-key, x-timestamp and x-signature headers are required');
    const op = (await this.db.get<OperatorRow>('SELECT * FROM operators WHERE api_key = ?', key)) ?? fail(401, 'BAD_API_KEY');
    if (!/^\d+$/.test(ts) || Math.abs(this.now() - Number(ts)) > SIGNATURE_WINDOW_MS) fail(401, 'STALE_TIMESTAMP', 'x-timestamp must be within 5 minutes (ms since epoch)');
    if (!safeEqual(signPayload(op!.secret, ts, method, path, body), sig)) fail(401, 'BAD_SIGNATURE');
    if (op!.status !== 'active') fail(403, 'OPERATOR_SUSPENDED');
    return op!;
  }

  // ---------- players ----------

  async upsertPlayer(op: OperatorRow, externalId: unknown, displayName: unknown): Promise<PlayerRow> {
    const ext = str(externalId, 'playerId', 100);
    const name = optStr(displayName, 'displayName', 40) ?? `Player ${ext.slice(-4)}`;
    await this.db.run(
      `INSERT INTO players (id, operator_id, external_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (operator_id, external_id) DO UPDATE SET display_name = excluded.display_name`,
      newId('pl'), op.id, ext, name, this.now(),
    );
    return (await this.db.get<PlayerRow>('SELECT * FROM players WHERE operator_id = ? AND external_id = ?', op.id, ext))!;
  }

  async playerByExternal(op: OperatorRow, externalId: unknown): Promise<PlayerRow> {
    return (await this.db.get<PlayerRow>('SELECT * FROM players WHERE operator_id = ? AND external_id = ?', op.id, str(externalId, 'playerId', 100))) ?? fail(404, 'PLAYER_NOT_FOUND');
  }

  async setPlayerStatus(op: OperatorRow, externalId: unknown, status: unknown) {
    if (status !== 'active' && status !== 'blocked') fail(400, 'BAD_INPUT', 'status must be active or blocked');
    const p = await this.playerByExternal(op, externalId);
    await this.db.tx(async () => {
      await this.db.run('UPDATE players SET status = ? WHERE id = ?', status, p.id);
      await this.audit.log(`operator:${op.id}`, 'player.status', { playerId: p.id, status });
    });
    return { playerId: p.external_id, status };
  }

  // Transfer wallet: the operator moves money in and out of GetFlop. txId makes retries safe.
  async transfer(op: OperatorRow, direction: 'deposit' | 'withdraw', input: Row) {
    if (op.wallet_mode !== 'transfer') fail(409, 'WRONG_WALLET_MODE', 'This operator uses a seamless wallet');
    const player = await this.playerByExternal(op, input.playerId);
    const amount = int(input.amount, 'amount', 1);
    // One txId = one transfer, whatever its direction. A retry with the same details is answered
    // without moving money again; reusing the id for anything else is refused.
    const ref = `${op.id}:${str(input.txId, 'txId', 100)}`;
    const signed = direction === 'deposit' ? amount : -amount;
    await this.db.tx(async () => {
      // Transfers recorded before txIds were unified used the kinds 'deposit' and 'withdraw' with
      // the same ref, and then one txId could have been used once in each direction. A retry that
      // matches any of those earlier transfers is the same transfer.
      const priors = await this.db.all<{ amount: number | null }>(
        `SELECT e.amount FROM ledger_tx t LEFT JOIN ledger_entries e ON e.tx_id = t.id AND e.account = ?
         WHERE t.ref = ? AND t.kind IN ('operator.transfer', 'deposit', 'withdraw')`,
        `player:${player.id}`, ref,
      );
      if (priors.length) {
        if (!priors.some((p) => p.amount === signed))
          fail(409, 'TX_ID_REUSED', 'This txId was already used for a different transfer (player, direction or amount)');
      } else {
        await this.ledger.transfer('operator.transfer', ref, op.currency, `operator:${op.id}`, `player:${player.id}`, signed);
      }
    });
    return { playerId: player.external_id, balance: await this.ledger.balance(`player:${player.id}`, op.currency), currency: op.currency };
  }

  // ---------- direct players (signed up on GetFlop itself) ----------
  // They belong to the built-in "GetFlop Direct" operator, which uses a transfer wallet
  // funded through the cashier (manual today, a payment provider later).

  async directOperator(currency = 'EUR'): Promise<OperatorRow> {
    const existing = await this.db.get<OperatorRow>("SELECT * FROM operators WHERE id = 'op_direct'");
    if (existing) return existing;
    await this.db.tx(async () => {
      const created = await this.db.run(
        `INSERT INTO operators (id, name, currency, wallet_mode, api_key, secret, commission_bps, created_at) VALUES ('op_direct', 'GetFlop Direct', ?, 'transfer', ?, ?, 0, ?)
         ON CONFLICT (id) DO NOTHING`,
        currency, `gfk_${newSecret(18)}`, newSecret(32), this.now(),
      );
      if (created.changes) await this.recordRate('op_direct', 0, 'system');
    });
    return this.operator('op_direct');
  }

  async registerPlayer(input: Row) {
    const username = str(input.username, 'username', 24, 3).toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username)) fail(400, 'BAD_INPUT', 'username may use letters, digits, dot, dash and underscore');
    const password = str(input.password, 'password', 200, 8);
    const op = await this.directOperator();
    const passwordHash = hashPassword(password);
    const player = await this.db.tx(async () => {
      if (await this.db.get('SELECT 1 FROM player_logins WHERE username = ?', username)) fail(409, 'USERNAME_TAKEN');
      const p = await this.upsertPlayer(op, `u:${username}`, optStr(input.displayName, 'displayName', 40) ?? username);
      await this.db.run('INSERT INTO player_logins (player_id, username, password_hash) VALUES (?, ?, ?)', p.id, username, passwordHash);
      await this.audit.log(`player:${p.id}`, 'player.register', { username });
      return p;
    });
    return { ...(await this.createPlayerSession(player)), player: { id: player.id, displayName: player.display_name } };
  }

  async loginPlayer(input: Row) {
    const username = String(input.username ?? '').toLowerCase();
    const row = await this.db.get('SELECT * FROM player_logins WHERE username = ?', username);
    if (!row || !checkPassword(String(input.password ?? ''), row.password_hash)) fail(401, 'BAD_CREDENTIALS');
    const player = (await this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', row!.player_id))!;
    if (player.status !== 'active') fail(403, 'PLAYER_BLOCKED');
    return { ...(await this.createPlayerSession(player)), player: { id: player.id, displayName: player.display_name } };
  }

  // Cashier for direct players: positive amount = deposit, negative = withdrawal.
  async cashier(playerId: string, amountInput: unknown, note: unknown, actor: string) {
    const player = (await this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', playerId)) ?? fail(404, 'PLAYER_NOT_FOUND');
    if (player!.operator_id !== 'op_direct') fail(409, 'NOT_DIRECT_PLAYER', "This player's money is managed by their operator");
    const amount = int(amountInput, 'amount', -1_000_000_000, 1_000_000_000);
    if (amount === 0) fail(400, 'BAD_INPUT', 'amount cannot be 0');
    const op = await this.operator('op_direct');
    const why = str(note, 'note', 200);
    await this.db.tx(async () => {
      await this.ledger.transfer(amount > 0 ? 'cashier.deposit' : 'cashier.withdraw', null, op.currency, 'house:cashier', `player:${player!.id}`, amount);
      await this.audit.log(actor, 'player.cashier', { playerId, amount, note: why });
    });
    return { playerId, balance: await this.ledger.balance(`player:${player!.id}`, op.currency), currency: op.currency };
  }

  // ---------- sessions ----------

  async createPlayerSession(player: PlayerRow) {
    const token = newSecret(24);
    await this.db.run("INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, 'player', ?, ?)", sha256(token), player.id, this.now() + PLAYER_SESSION_MS);
    return { token, expiresAt: this.now() + PLAYER_SESSION_MS };
  }

  async playerFromToken(token: string): Promise<PlayerRow> {
    const s = await this.session(token, 'player');
    return (await this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', s.subject_id)) ?? fail(401, 'SESSION_EXPIRED');
  }

  async createStaff(username: unknown, password: unknown, role: unknown, actor: string) {
    const u = str(username, 'username', 40, 3).toLowerCase();
    const p = str(password, 'password', 200, 10);
    if (role !== 'admin' && role !== 'supervisor' && role !== 'dealer') fail(400, 'BAD_INPUT', 'role must be admin, supervisor or dealer');
    const id = newId('st');
    const passwordHash = hashPassword(p);
    await this.db.tx(async () => {
      if (await this.db.get('SELECT 1 FROM staff WHERE username = ?', u)) fail(409, 'USERNAME_TAKEN');
      await this.db.run('INSERT INTO staff (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', id, u, passwordHash, role, this.now());
      await this.audit.log(actor, 'staff.create', { staffId: id, username: u, role });
    });
    return { id, username: u, role };
  }

  listStaff() {
    return this.db.all('SELECT id, username, role, created_at FROM staff ORDER BY username');
  }

  async staffLogin(username: unknown, password: unknown) {
    const row = await this.db.get('SELECT * FROM staff WHERE username = ?', String(username ?? '').toLowerCase());
    if (!row || !checkPassword(String(password ?? ''), row.password_hash)) {
      await this.audit.log('anonymous', 'staff.login_failed', { username: String(username ?? '').slice(0, 40) });
      fail(401, 'BAD_CREDENTIALS');
    }
    const token = newSecret(24);
    await this.db.run("INSERT INTO sessions (token_hash, kind, subject_id, expires_at) VALUES (?, 'staff', ?, ?)", sha256(token), row!.id, this.now() + STAFF_SESSION_MS);
    await this.audit.log(`staff:${row!.username}`, 'staff.login', {});
    return { token, user: { id: row!.id, username: row!.username, role: row!.role } };
  }

  async staffFromToken(token: string) {
    const s = await this.session(token, 'staff');
    return (await this.db.get<{ id: string; username: string; role: string }>('SELECT id, username, role FROM staff WHERE id = ?', s.subject_id)) ?? fail(401, 'SESSION_EXPIRED');
  }

  async logout(token: string) {
    await this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  private async session(token: string, kind: string) {
    const s = await this.db.get('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', sha256(token), kind);
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
