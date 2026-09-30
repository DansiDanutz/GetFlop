// Wires the services together and defines the HTTP API.
//   /v1/...           player app (session token from the operator launch) and public live data
//   /v1/staff, /v1/dealer, /v1/admin   staff screens (username + password login)
//   /v1/operator/...  signed server-to-server API for partners (see docs/INTEGRATION.md)

import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Db } from './db.ts';
import { Ledger } from './ledger.ts';
import { Audit } from './audit.ts';
import { Events } from './events.ts';
import { type FetchFn, SeamlessWallet } from './wallet.ts';
import { Game, type PlayerRow } from './game.ts';
import { Accounts } from './accounts.ts';
import { Billing } from './billing.ts';
import { STRATEGIES, Tournaments } from './tournaments.ts';
import { DEMO_STAFF } from './seed.ts';
import { dispatch, openStream, type Req, Router, serveStatic, STREAMED } from './http.ts';
import { fail, int, newSecret, str } from './util.ts';
import { MARKETS, priceList } from './markets.ts';

export type AppOptions = {
  dbFile?: string;
  publicUrl?: string;
  now?: () => number;
  fetchFn?: FetchFn;
  directCurrency?: string; // currency of players who sign up on GetFlop directly
  log?: (msg: string, err?: unknown) => void;
  // Demo mode: exposes /v1/demo/* (instant play-money players, the demo staff logins).
  demo?: boolean;
  // Serverless hosting has no background timers: advance round/tournament clocks on each request.
  tickOnRequest?: boolean;
};

const ROLE_RANK: Record<string, number> = { dealer: 1, supervisor: 2, admin: 3 };

export function createApp(opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(m, e ?? ''));
  const publicUrl = (opts.publicUrl ?? 'http://localhost:4000').replace(/\/$/, '');
  const db = new Db(opts.dbFile);
  const audit = new Audit(db, now);
  const ledger = new Ledger(db, now);
  const events = new Events();
  const wallet = new SeamlessWallet(db, audit, now, opts.fetchFn);
  const game = new Game(db, ledger, audit, events, wallet, now);
  const accounts = new Accounts(db, ledger, audit, now);
  const billing = new Billing(db, audit, now);
  const tournaments = new Tournaments(db, ledger, audit, events, game, now);
  accounts.directOperator(opts.directCurrency ?? 'EUR');

  const bearer = (req: Req) => {
    const h = String(req.headers.authorization ?? '');
    return h.startsWith('Bearer ') ? h.slice(7) : fail(401, 'NO_SESSION');
  };
  const player = (req: Req) => accounts.playerFromToken(bearer(req));
  const staff = (req: Req, minRole: 'dealer' | 'supervisor' | 'admin') => {
    const s = accounts.staffFromToken(bearer(req));
    if (ROLE_RANK[s.role] < ROLE_RANK[minRole]) fail(403, 'FORBIDDEN', `Requires ${minRole} role`);
    return { ...s, actor: `staff:${s.username}` };
  };
  const operator = (req: Req) => accounts.authenticateOperator(req.headers, req.method, req.url, req.rawBody);
  const range = (req: Req) => {
    const to = req.query.get('to') ? Number(req.query.get('to')) : now() + 1;
    const from = req.query.get('from') ? Number(req.query.get('from')) : to - 30 * 86_400_000;
    return { from: int(from, 'from'), to: int(to, 'to') };
  };

  async function balanceOf(p: PlayerRow) {
    const op = accounts.operator(p.operator_id);
    if (op.wallet_mode === 'transfer') return { balance: ledger.balance(`player:${p.id}`, op.currency), currency: op.currency };
    const res = await wallet.call(op, 'balance', { playerId: p.external_id, currency: op.currency });
    return { balance: res.ok ? (res.balance ?? null) : null, currency: op.currency };
  }

  const r = new Router();

  // ----- public + player -----
  r.get('/v1/health', () => ({ ok: true, time: now() }));
  r.get('/v1/markets', () => [...MARKETS.values()].map((m) => ({ id: m.id, group: m.group, name: m.name, probability: m.probability, winningFlops: m.winningFlops })));
  r.get('/v1/tables', () => game.listTables());
  r.get('/v1/tables/:id', (req) => game.tableView(req.params.id));
  r.get('/v1/stream', (req) => {
    const tableId = req.query.get('table');
    if (tableId) game.table(tableId);
    const send = openStream(req.res);
    const offs = [events.subscribe('lobby', send)];
    if (tableId) offs.push(events.subscribe(`table:${tableId}`, send));
    req.res.on('close', () => offs.forEach((off) => off()));
    return STREAMED;
  });
  r.get('/v1/me', async (req) => {
    const p = player(req);
    return { playerId: p.id, displayName: p.display_name, seatedAt: game.seatOf(p.id), ...(await balanceOf(p)) };
  });
  r.get('/v1/me/bets', (req) => game.playerBets(player(req).id));
  r.post('/v1/bets', (req) => game.placeBet(player(req), req.body));
  r.post('/v1/auth/register', (req) => accounts.registerPlayer(req.body));
  r.post('/v1/auth/login', (req) => accounts.loginPlayer(req.body));
  r.post('/v1/auth/logout', (req) => { accounts.logout(bearer(req)); return { ok: true }; });

  // ----- tournaments -----
  r.get('/v1/tournaments', (req) => tournaments.list(req.query.get('all') === '1'));
  r.get('/v1/tournaments/:id', (req) => {
    const token = String(req.headers.authorization ?? '');
    return tournaments.view(req.params.id, token.startsWith('Bearer ') ? player(req).id : undefined);
  });
  r.get('/v1/tournaments/:id/stream', (req) => {
    tournaments.get(req.params.id);
    const send = openStream(req.res);
    const off = events.subscribe(`tournament:${req.params.id}`, send);
    req.res.on('close', off);
    return STREAMED;
  });
  r.post('/v1/tournaments/:id/join', (req) => tournaments.join(req.params.id, player(req)));
  r.post('/v1/tournaments/:id/bets', (req) => tournaments.placeBet(req.params.id, player(req), req.body));

  // ----- staff -----
  r.post('/v1/staff/login', (req) => accounts.staffLogin(req.body.username, req.body.password));
  r.post('/v1/staff/logout', (req) => { accounts.logout(bearer(req)); return { ok: true }; });
  r.get('/v1/staff/me', (req) => staff(req, 'dealer'));

  r.get('/v1/dealer/tables', (req) => { staff(req, 'dealer'); return game.listTables(); });
  r.post('/v1/dealer/tables/:id/rounds', (req) => game.openRound(req.params.id, staff(req, 'dealer').actor));
  r.post('/v1/dealer/rounds/:id/close', (req) => game.closeRound(req.params.id, staff(req, 'dealer').actor));
  r.post('/v1/dealer/rounds/:id/flop', (req) => game.submitFlop(req.params.id, req.body.cards, staff(req, 'dealer').actor));
  r.post('/v1/dealer/rounds/:id/void', (req) => game.voidRound(req.params.id, req.body.reason, staff(req, 'supervisor').actor));
  r.get('/v1/dealer/tables/:id/seats', (req) => { staff(req, 'dealer'); return game.seats(req.params.id); });
  r.post('/v1/dealer/tables/:id/seats', (req) => game.seatPlayer(req.params.id, str(req.body.playerId, 'playerId', 64), staff(req, 'dealer').actor));
  r.post('/v1/dealer/tables/:id/seats/:playerId/remove', (req) => game.unseatPlayer(req.params.id, req.params.playerId, staff(req, 'dealer').actor));
  r.get('/v1/dealer/players', (req) => {
    staff(req, 'dealer');
    const q = `%${(req.query.get('q') ?? '').trim()}%`;
    if (q.length < 4) return [];
    return db.all(
      `SELECT p.id AS playerId, p.display_name AS displayName, l.username, o.name AS operator, s.table_id AS seatedAt
       FROM players p JOIN operators o ON o.id = p.operator_id LEFT JOIN player_logins l ON l.player_id = p.id LEFT JOIN seats s ON s.player_id = p.id
       WHERE p.display_name LIKE ? OR l.username LIKE ? ORDER BY p.display_name LIMIT 20`,
      q, q,
    );
  });
  r.get('/v1/dealer/rounds/:id/risk', (req) => { staff(req, 'dealer'); return game.roundRisk(req.params.id); });

  // ----- admin -----
  r.get('/v1/admin/tables', (req) => { staff(req, 'supervisor'); return game.listTables(true); });
  r.post('/v1/admin/tables', (req) => game.createTable(req.body, staff(req, 'admin').actor));
  r.patch('/v1/admin/tables/:id', (req) => game.updateTable(req.params.id, req.body, staff(req, 'admin').actor));
  r.get('/v1/admin/pricing', (req) => { staff(req, 'supervisor'); return priceList(int(Number(req.query.get('marginBps') ?? 500), 'marginBps', 0, 3000)); });
  r.get('/v1/admin/tournaments', (req) => { staff(req, 'supervisor'); return tournaments.list(true); });
  r.get('/v1/admin/tournament-strategies', (req) => { staff(req, 'supervisor'); return [...STRATEGIES.values()].map((s) => ({ id: s.id, name: s.name, defaults: s.parseRules({}) })); });
  r.post('/v1/admin/tournaments', (req) => tournaments.create(req.body, staff(req, 'admin').actor));
  r.post('/v1/admin/tournaments/:id/cancel', (req) => tournaments.cancel(req.params.id, req.body.reason, staff(req, 'admin').actor));
  r.get('/v1/admin/players', (req) => {
    staff(req, 'supervisor');
    const q = `%${req.query.get('q') ?? ''}%`;
    return db.all(
      `SELECT p.id, p.display_name AS displayName, p.external_id AS externalId, p.status, o.name AS operator, o.currency, l.username,
              COALESCE(b.balance, 0) AS balance
       FROM players p JOIN operators o ON o.id = p.operator_id LEFT JOIN player_logins l ON l.player_id = p.id
       LEFT JOIN balances b ON b.account = 'player:' || p.id AND b.currency = o.currency
       WHERE p.display_name LIKE ? OR l.username LIKE ? OR p.external_id LIKE ? ORDER BY p.created_at DESC LIMIT 100`,
      q, q, q,
    );
  });
  r.post('/v1/admin/players/:id/cashier', (req) => accounts.cashier(req.params.id, req.body.amount, req.body.note, staff(req, 'admin').actor));
  r.get('/v1/admin/operators', (req) => { staff(req, 'admin'); return accounts.listOperators(); });
  r.post('/v1/admin/operators', (req) => accounts.createOperator(req.body, staff(req, 'admin').actor));
  r.patch('/v1/admin/operators/:id', (req) => accounts.updateOperator(req.params.id, req.body, staff(req, 'admin').actor));
  r.post('/v1/admin/operators/:id/rotate-secret', (req) => accounts.rotateSecret(req.params.id, staff(req, 'admin').actor));
  r.get('/v1/admin/staff', (req) => { staff(req, 'admin'); return accounts.listStaff(); });
  r.post('/v1/admin/staff', (req) => accounts.createStaff(req.body.username, req.body.password, req.body.role, staff(req, 'admin').actor));
  r.get('/v1/admin/reports/ggr', (req) => { staff(req, 'admin'); const { from, to } = range(req); return { from, to, rows: billing.report(from, to) }; });
  r.get('/v1/admin/invoices', (req) => { staff(req, 'admin'); return billing.listInvoices(req.query.get('operatorId') ?? undefined); });
  r.post('/v1/admin/invoices', (req) => billing.createInvoice(str(req.body.operatorId, 'operatorId'), req.body.from, req.body.to, staff(req, 'admin').actor));
  r.get('/v1/admin/audit', (req) => { staff(req, 'supervisor'); return audit.list(200, req.query.get('action') ?? undefined); });
  r.get('/v1/admin/integrity', (req) => { staff(req, 'admin'); return { ledger: ledger.verify(), audit: audit.verify() }; });
  r.get('/v1/admin/outbox', (req) => { staff(req, 'admin'); return wallet.stuck(); });
  r.post('/v1/admin/outbox/retry', (req) => {
    const s = staff(req, 'admin');
    const operatorId = req.body.operatorId ? str(req.body.operatorId, 'operatorId', 64) : undefined;
    audit.log(s.actor, 'outbox.retry_now', { operatorId: operatorId ?? 'all' });
    return wallet.retryNow(operatorId);
  });

  // ----- demo -----
  r.get('/v1/demo/info', () => ({ demo: !!opts.demo, staff: opts.demo ? DEMO_STAFF : [] }));
  if (opts.demo) {
    // One tap to play: a fresh sign-up player with 500.00 of play money.
    r.post('/v1/demo/player', () => {
      const n = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
      const res = accounts.registerPlayer({ username: `guest${n}`, password: newSecret(18), displayName: `Guest ${n.slice(-4)}` });
      accounts.cashier(res.player.id, 50_000, 'demo credit', 'system');
      return res;
    });
  }

  // ----- operator (partner) API, HMAC-signed -----
  r.post('/v1/operator/sessions', (req) => {
    const op = operator(req);
    const p = accounts.upsertPlayer(op, req.body.playerId, req.body.displayName);
    if (p.status !== 'active') fail(403, 'PLAYER_BLOCKED');
    const s = accounts.createPlayerSession(p);
    const table = req.body.tableId ? `&table=${encodeURIComponent(String(req.body.tableId))}` : '';
    return { ...s, launchUrl: `${publicUrl}/play.html#token=${s.token}${table}` };
  });
  r.get('/v1/operator/tables', (req) => { operator(req); return game.listTables(); });
  r.post('/v1/operator/players/deposit', (req) => accounts.transfer(operator(req), 'deposit', req.body));
  r.post('/v1/operator/players/withdraw', (req) => accounts.transfer(operator(req), 'withdraw', req.body));
  r.post('/v1/operator/players/status', (req) => { const op = operator(req); return accounts.setPlayerStatus(op, req.body.playerId, req.body.status); });
  r.post('/v1/operator/players/balance', async (req) => {
    const op = operator(req);
    return { playerId: req.body.playerId, ...(await balanceOf(accounts.playerByExternal(op, req.body.playerId))) };
  });
  // Reconciliation feed: every bet of this operator placed in [from, to), oldest first, in pages.
  // Pass the returned nextCursor to get the next page; it is null on the last page.
  r.get('/v1/operator/bets', (req) => {
    const op = operator(req);
    const { from, to } = range(req);
    const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 500) || 500, 1), 1000);
    let after = { at: -1, id: '' };
    const cursor = req.query.get('cursor');
    if (cursor) {
      const m = /^(\d+):(bet_[\w-]+)$/.exec(Buffer.from(cursor, 'base64url').toString());
      if (!m) fail(400, 'BAD_CURSOR');
      after = { at: Number(m![1]), id: m![2] };
    }
    const rows = db.all(
      `SELECT b.id, p.external_id AS playerId, b.round_id AS roundId, r.number AS roundNumber, r.table_id AS tableId, b.market_id AS marketId,
              b.currency, b.stake, b.odds_x100 AS oddsX100, b.status, b.payout, b.placed_at AS placedAt, b.settled_at AS settledAt, r.flop
       FROM bets b JOIN players p ON p.id = b.player_id JOIN rounds r ON r.id = b.round_id
       WHERE b.operator_id = ? AND b.placed_at >= ? AND b.placed_at < ? AND (b.placed_at > ? OR (b.placed_at = ? AND b.id > ?))
       ORDER BY b.placed_at, b.id LIMIT ?`,
      op.id, from, to, after.at, after.at, after.id, limit + 1,
    );
    const page = rows.slice(0, limit);
    const lastRow = page.at(-1);
    return {
      bets: page.map((b) => ({ ...b, flop: b.flop ? JSON.parse(b.flop) : null })),
      nextCursor: rows.length > limit && lastRow ? Buffer.from(`${lastRow.placedAt}:${lastRow.id}`).toString('base64url') : null,
    };
  });
  r.get('/v1/operator/reports/ggr', (req) => { const op = operator(req); const { from, to } = range(req); return billing.report(from, to, op.id); });
  r.get('/v1/operator/invoices', (req) => billing.listInvoices(operator(req).id));

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/v1/')) {
      if (opts.tickOnRequest) runTicks();
      return dispatch(r, req, res, (e) => log('request failed', e));
    }
    if (req.method === 'GET' && (await serveStatic(publicDir, path, res))) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });

  let delivering = false;
  function runTicks() {
    try { game.tick(); tournaments.tick(); } catch (e) { log('tick failed', e); }
    if (!delivering) {
      delivering = true;
      wallet.deliverDue().catch((e) => log('outbox failed', e)).finally(() => { delivering = false; });
    }
  }

  const timers: NodeJS.Timeout[] = [];
  function startBackground() {
    timers.push(setInterval(() => { try { game.tick(); tournaments.tick(); } catch (e) { log('tick failed', e); } }, 250));
    timers.push(setInterval(async () => {
      if (delivering) return;
      delivering = true;
      try { await wallet.deliverDue(); } catch (e) { log('outbox failed', e); } finally { delivering = false; }
    }, 1000));
  }

  // First start: create the admin account from environment variables.
  function bootstrapAdmin(username?: string, password?: string) {
    if (db.get('SELECT 1 FROM staff LIMIT 1')) return false;
    if (!username || !password) return false;
    accounts.createStaff(username, password, 'admin', 'system');
    return true;
  }

  function stop() {
    timers.forEach(clearInterval);
    server.closeAllConnections?.();
    server.close();
    db.close();
  }

  return { server, db, ledger, audit, events, wallet, game, accounts, billing, tournaments, startBackground, bootstrapAdmin, stop };
}

export type App = ReturnType<typeof createApp>;
