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
import { SaferPlay } from './safer.ts';
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

export async function createApp(opts: AppOptions = {}) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(m, e ?? ''));
  const publicUrl = (opts.publicUrl ?? 'http://localhost:4000').replace(/\/$/, '');
  const db = await Db.open(opts.dbFile);
  const audit = new Audit(db, now);
  const ledger = new Ledger(db, now);
  const events = new Events();
  const wallet = new SeamlessWallet(db, audit, now, opts.fetchFn);
  const safer = new SaferPlay(db, audit, now);
  const game = new Game(db, ledger, audit, events, wallet, now, safer);
  const accounts = new Accounts(db, ledger, audit, now, safer);
  const billing = new Billing(db, audit, now);
  const tournaments = new Tournaments(db, ledger, audit, events, game, now);
  await accounts.directOperator(opts.directCurrency ?? 'EUR');

  const bearer = (req: Req) => {
    const h = String(req.headers.authorization ?? '');
    return h.startsWith('Bearer ') ? h.slice(7) : fail(401, 'NO_SESSION');
  };
  const player = (req: Req) => accounts.playerFromToken(bearer(req));
  const staff = async (req: Req, minRole: 'dealer' | 'supervisor' | 'admin') => {
    const s = await accounts.staffFromToken(bearer(req));
    if (ROLE_RANK[s.role] < ROLE_RANK[minRole]) fail(403, 'FORBIDDEN', `Requires ${minRole} role`);
    return { ...s, actor: `staff:${s.username}` };
  };
  const actor = async (req: Req, minRole: 'dealer' | 'supervisor' | 'admin') => (await staff(req, minRole)).actor;
  const operator = (req: Req) => accounts.authenticateOperator(req.headers, req.method, req.url, req.rawBody);
  const range = (req: Req) => {
    const to = req.query.get('to') ? Number(req.query.get('to')) : now() + 1;
    const from = req.query.get('from') ? Number(req.query.get('from')) : to - 30 * 86_400_000;
    return { from: int(from, 'from'), to: int(to, 'to') };
  };

  async function balanceOf(p: PlayerRow) {
    const op = await accounts.operator(p.operator_id);
    if (op.wallet_mode === 'transfer') return { balance: await ledger.balance(`player:${p.id}`, op.currency), currency: op.currency };
    const res = await wallet.call(op, 'balance', { playerId: p.external_id, currency: op.currency });
    return { balance: res.ok ? (res.balance ?? null) : null, currency: op.currency };
  }

  const r = new Router();

  // ----- public + player -----
  r.get('/v1/health', () => ({ ok: true, time: now() }));
  r.get('/v1/markets', () => [...MARKETS.values()].map((m) => ({ id: m.id, group: m.group, name: m.name, probability: m.probability, winningFlops: m.winningFlops })));
  r.get('/v1/tables', () => game.listTables());
  r.get('/v1/tables/:id', (req) => game.tableView(req.params.id));
  r.get('/v1/stream', async (req) => {
    const tableId = req.query.get('table');
    if (tableId) await game.table(tableId);
    const send = openStream(req.res);
    const offs = [events.subscribe('lobby', send)];
    if (tableId) offs.push(events.subscribe(`table:${tableId}`, send));
    req.res.on('close', () => offs.forEach((off) => off()));
    return STREAMED;
  });
  r.get('/v1/me', async (req) => {
    const p = await player(req);
    return { playerId: p.id, displayName: p.display_name, direct: p.operator_id === 'op_direct', seatedAt: await game.seatOf(p.id), ...(await balanceOf(p)) };
  });
  // Everything about the player's own account on one screen.
  r.get('/v1/me/account', async (req) => {
    const p = await player(req);
    const op = await accounts.operator(p.operator_id);
    const direct = p.operator_id === 'op_direct';
    return {
      profile: {
        playerId: p.id, displayName: p.display_name, username: await accounts.login(p.id), memberSince: Number(p.created_at),
        status: p.status, accountType: direct ? 'direct' : 'partner', via: direct ? 'GetFlop' : op.name,
      },
      ...(await balanceOf(p)),
      stats: await accounts.bettingStats(p.id),
      statement: op.wallet_mode === 'transfer' ? await accounts.statement(p, op.currency, Math.min(Number(req.query.get('limit') ?? 50) || 50, 200)) : null,
      tournaments: await accounts.playerTournaments(p.id),
      limits: direct ? await safer.view(p) : null,
      seatedAt: await game.seatOf(p.id),
    };
  });
  r.post('/v1/me/profile', async (req) => accounts.updateProfile(await player(req), req.body));
  r.post('/v1/me/password', async (req) => accounts.changePassword(await player(req), req.body, bearer(req)));
  // Safer play (direct players): limits and breaks. See safer.ts.
  r.get('/v1/me/limits', async (req) => safer.view(await player(req)));
  r.post('/v1/me/limits', async (req) => safer.setLimits(await player(req), req.body));
  r.post('/v1/me/break', async (req) => safer.takeBreak(await player(req), req.body.days));
  r.get('/v1/me/bets', async (req) => game.playerBets((await player(req)).id));
  r.post('/v1/bets', async (req) => game.placeBet(await player(req), req.body));
  r.post('/v1/auth/register', (req) => accounts.registerPlayer(req.body));
  r.post('/v1/auth/login', (req) => accounts.loginPlayer(req.body));
  r.post('/v1/auth/logout', async (req) => { await accounts.logout(bearer(req)); return { ok: true }; });

  // ----- tournaments -----
  r.get('/v1/tournaments', (req) => tournaments.list(req.query.get('all') === '1'));
  r.get('/v1/tournaments/:id', async (req) => {
    const token = String(req.headers.authorization ?? '');
    return tournaments.view(req.params.id, token.startsWith('Bearer ') ? (await player(req)).id : undefined);
  });
  r.get('/v1/tournaments/:id/stream', async (req) => {
    await tournaments.get(req.params.id);
    const send = openStream(req.res);
    const off = events.subscribe(`tournament:${req.params.id}`, send);
    req.res.on('close', off);
    return STREAMED;
  });
  r.post('/v1/tournaments/:id/join', async (req) => tournaments.join(req.params.id, await player(req)));
  r.post('/v1/tournaments/:id/bets', async (req) => tournaments.placeBet(req.params.id, await player(req), req.body));

  // ----- staff -----
  r.post('/v1/staff/login', (req) => accounts.staffLogin(req.body.username, req.body.password));
  r.post('/v1/staff/logout', async (req) => { await accounts.logout(bearer(req)); return { ok: true }; });
  r.get('/v1/staff/me', (req) => staff(req, 'dealer'));

  r.get('/v1/dealer/tables', async (req) => { await staff(req, 'dealer'); return game.listTables(); });
  r.post('/v1/dealer/tables/:id/rounds', async (req) => game.openRound(req.params.id, await actor(req, 'dealer')));
  r.post('/v1/dealer/rounds/:id/close', async (req) => game.closeRound(req.params.id, await actor(req, 'dealer')));
  r.post('/v1/dealer/rounds/:id/flop', async (req) => game.submitFlop(req.params.id, req.body.cards, await actor(req, 'dealer')));
  r.post('/v1/dealer/rounds/:id/void', async (req) => game.voidRound(req.params.id, req.body.reason, await actor(req, 'supervisor')));
  r.get('/v1/dealer/tables/:id/seats', async (req) => { await staff(req, 'dealer'); return game.seats(req.params.id); });
  r.post('/v1/dealer/tables/:id/seats', async (req) => {
    const by = await actor(req, 'dealer');
    return game.seatPlayer(req.params.id, str(req.body.playerId, 'playerId', 64), by);
  });
  r.post('/v1/dealer/tables/:id/seats/:playerId/remove', async (req) => game.unseatPlayer(req.params.id, req.params.playerId, await actor(req, 'dealer')));
  r.get('/v1/dealer/players', async (req) => {
    await staff(req, 'dealer');
    const q = `%${(req.query.get('q') ?? '').trim()}%`;
    if (q.length < 4) return [];
    return db.all(
      `SELECT p.id AS "playerId", p.display_name AS "displayName", l.username, o.name AS operator, s.table_id AS "seatedAt"
       FROM players p JOIN operators o ON o.id = p.operator_id LEFT JOIN player_logins l ON l.player_id = p.id LEFT JOIN seats s ON s.player_id = p.id
       WHERE p.display_name LIKE ? OR l.username LIKE ? ORDER BY p.display_name LIMIT 20`,
      q, q,
    );
  });
  r.get('/v1/dealer/rounds/:id/risk', async (req) => { await staff(req, 'dealer'); return game.roundRisk(req.params.id); });

  // ----- admin -----
  r.get('/v1/admin/tables', async (req) => { await staff(req, 'supervisor'); return game.listTables(true); });
  r.post('/v1/admin/tables', async (req) => game.createTable(req.body, await actor(req, 'admin')));
  r.patch('/v1/admin/tables/:id', async (req) => game.updateTable(req.params.id, req.body, await actor(req, 'admin')));
  r.get('/v1/admin/pricing', async (req) => { await staff(req, 'supervisor'); return priceList(int(Number(req.query.get('marginBps') ?? 500), 'marginBps', 0, 3000)); });
  r.get('/v1/admin/tournaments', async (req) => { await staff(req, 'supervisor'); return tournaments.list(true); });
  r.get('/v1/admin/tournament-strategies', async (req) => { await staff(req, 'supervisor'); return [...STRATEGIES.values()].map((s) => ({ id: s.id, name: s.name, defaults: s.parseRules({}) })); });
  r.post('/v1/admin/tournaments', async (req) => tournaments.create(req.body, await actor(req, 'admin')));
  r.post('/v1/admin/tournaments/:id/cancel', async (req) => tournaments.cancel(req.params.id, req.body.reason, await actor(req, 'admin')));
  r.get('/v1/admin/players', async (req) => {
    await staff(req, 'supervisor');
    const q = `%${req.query.get('q') ?? ''}%`;
    return db.all(
      `SELECT p.id, p.display_name AS "displayName", p.external_id AS "externalId", p.status, o.name AS operator, o.currency, l.username,
              COALESCE(b.balance, 0) AS balance, CASE WHEN pl.excluded_until > ? THEN pl.excluded_until END AS "onBreakUntil"
       FROM players p JOIN operators o ON o.id = p.operator_id LEFT JOIN player_logins l ON l.player_id = p.id
       LEFT JOIN balances b ON b.account = 'player:' || p.id AND b.currency = o.currency
       LEFT JOIN player_limits pl ON pl.player_id = p.id
       WHERE p.display_name LIKE ? OR l.username LIKE ? OR p.external_id LIKE ? ORDER BY p.created_at DESC LIMIT 100`,
      now(), q, q, q,
    );
  });
  r.get('/v1/admin/players/:id/limits', async (req) => {
    await staff(req, 'supervisor');
    const p = (await db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', req.params.id)) ?? fail(404, 'PLAYER_NOT_FOUND');
    return safer.view(p!);
  });
  r.post('/v1/admin/players/:id/cashier', async (req) => accounts.cashier(req.params.id, req.body.amount, req.body.note, await actor(req, 'admin')));
  r.get('/v1/admin/operators', async (req) => { await staff(req, 'admin'); return accounts.listOperators(); });
  r.post('/v1/admin/operators', async (req) => accounts.createOperator(req.body, await actor(req, 'admin')));
  r.patch('/v1/admin/operators/:id', async (req) => accounts.updateOperator(req.params.id, req.body, await actor(req, 'admin')));
  r.post('/v1/admin/operators/:id/rotate-secret', async (req) => accounts.rotateSecret(req.params.id, await actor(req, 'admin')));
  r.get('/v1/admin/staff', async (req) => { await staff(req, 'admin'); return accounts.listStaff(); });
  r.post('/v1/admin/staff', async (req) => accounts.createStaff(req.body.username, req.body.password, req.body.role, await actor(req, 'admin')));
  r.get('/v1/admin/reports/ggr', async (req) => { await staff(req, 'admin'); const { from, to } = range(req); return { from, to, rows: await billing.report(from, to) }; });
  r.get('/v1/admin/invoices', async (req) => { await staff(req, 'admin'); return billing.listInvoices(req.query.get('operatorId') ?? undefined); });
  r.post('/v1/admin/invoices', async (req) => billing.createInvoice(str(req.body.operatorId, 'operatorId'), req.body.from, req.body.to, await actor(req, 'admin')));
  r.get('/v1/admin/audit', async (req) => { await staff(req, 'supervisor'); return audit.list(200, req.query.get('action') ?? undefined); });
  r.get('/v1/admin/integrity', async (req) => { await staff(req, 'admin'); return { ledger: await ledger.verify(), audit: await audit.verify() }; });
  r.get('/v1/admin/outbox', async (req) => { await staff(req, 'admin'); return wallet.stuck(); });
  r.post('/v1/admin/outbox/retry', async (req) => {
    const by = await actor(req, 'admin');
    const operatorId = req.body.operatorId ? str(req.body.operatorId, 'operatorId', 64) : undefined;
    await audit.log(by, 'outbox.retry_now', { operatorId: operatorId ?? 'all' });
    return wallet.retryNow(operatorId);
  });

  // ----- demo -----
  r.get('/v1/demo/info', () => ({ demo: !!opts.demo, staff: opts.demo ? DEMO_STAFF : [] }));
  if (opts.demo) {
    // One tap to play: a fresh sign-up player with 500.00 of play money.
    r.post('/v1/demo/player', async () => {
      const n = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
      const res = await accounts.registerPlayer({ username: `guest${n}`, password: newSecret(18), displayName: `Guest ${n.slice(-4)}` });
      await accounts.cashier(res.player.id, 50_000, 'demo credit', 'system');
      return res;
    });
  }

  // ----- operator (partner) API, HMAC-signed -----
  r.post('/v1/operator/sessions', async (req) => {
    const op = await operator(req);
    const p = await accounts.upsertPlayer(op, req.body.playerId, req.body.displayName);
    if (p.status !== 'active') fail(403, 'PLAYER_BLOCKED');
    const s = await accounts.createPlayerSession(p);
    const table = req.body.tableId ? `&table=${encodeURIComponent(String(req.body.tableId))}` : '';
    return { ...s, launchUrl: `${publicUrl}/play.html#token=${s.token}${table}` };
  });
  r.get('/v1/operator/tables', async (req) => { await operator(req); return game.listTables(); });
  r.post('/v1/operator/players/deposit', async (req) => accounts.transfer(await operator(req), 'deposit', req.body));
  r.post('/v1/operator/players/withdraw', async (req) => accounts.transfer(await operator(req), 'withdraw', req.body));
  r.post('/v1/operator/players/status', async (req) => accounts.setPlayerStatus(await operator(req), req.body.playerId, req.body.status));
  r.post('/v1/operator/players/balance', async (req) => {
    const op = await operator(req);
    return { playerId: req.body.playerId, ...(await balanceOf(await accounts.playerByExternal(op, req.body.playerId))) };
  });
  // Reconciliation feed: every bet of this operator placed in [from, to), oldest first, in pages.
  // Pass the returned nextCursor to get the next page; it is null on the last page.
  r.get('/v1/operator/bets', async (req) => {
    const op = await operator(req);
    const { from, to } = range(req);
    const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 500) || 500, 1), 1000);
    let after = { at: -1, id: '' };
    const cursor = req.query.get('cursor');
    if (cursor) {
      const m = /^(\d+):(bet_[\w-]+)$/.exec(Buffer.from(cursor, 'base64url').toString());
      if (!m) fail(400, 'BAD_CURSOR');
      after = { at: Number(m![1]), id: m![2] };
    }
    const rows = await db.all(
      `SELECT b.id, p.external_id AS "playerId", b.round_id AS "roundId", r.number AS "roundNumber", r.table_id AS "tableId", b.market_id AS "marketId",
              b.currency, b.stake, b.odds_x100 AS "oddsX100", b.status, b.payout, b.placed_at AS "placedAt", b.settled_at AS "settledAt", r.flop
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
  r.get('/v1/operator/reports/ggr', async (req) => { const op = await operator(req); const { from, to } = range(req); return billing.report(from, to, op.id); });
  r.get('/v1/operator/invoices', async (req) => billing.listInvoices((await operator(req)).id));

  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/v1/')) {
      // Serverless: finish due clock work (close rounds, finish tournaments) before answering.
      if (opts.tickOnRequest) await runTicks();
      return dispatch(r, req, res, (e) => log('request failed', e));
    }
    if (req.method === 'GET' && (await serveStatic(publicDir, path, res))) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });

  let ticking: Promise<void> | null = null;
  function tickOnce() {
    // One tick at a time; concurrent callers share the running one.
    ticking ??= (async () => {
      try { await game.tick(); await tournaments.tick(); } catch (e) { log('tick failed', e); } finally { ticking = null; }
    })();
    return ticking;
  }
  let delivering = false;
  async function deliver() {
    if (delivering) return;
    delivering = true;
    try { await wallet.deliverDue(); } catch (e) { log('outbox failed', e); } finally { delivering = false; }
  }
  async function runTicks() {
    await tickOnce();
    void deliver();
  }

  const timers: NodeJS.Timeout[] = [];
  function startBackground() {
    timers.push(setInterval(() => void tickOnce(), 250));
    timers.push(setInterval(() => void deliver(), 1000));
  }

  // First start: create the admin account from environment variables.
  async function bootstrapAdmin(username?: string, password?: string) {
    if (await db.get('SELECT 1 FROM staff LIMIT 1')) return false;
    if (!username || !password) return false;
    await accounts.createStaff(username, password, 'admin', 'system');
    return true;
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    timers.forEach(clearInterval);
    server.closeAllConnections?.();
    server.close();
    await ticking;
    await db.close();
  }

  return { server, db, ledger, audit, events, wallet, game, accounts, safer, billing, tournaments, startBackground, bootstrapAdmin, stop, tick: tickOnce };
}

export type App = Awaited<ReturnType<typeof createApp>>;
