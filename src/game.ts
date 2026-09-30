// Tables, rounds and bets.
//
// Round life cycle (one round = one real hand dealt at a real table):
//   open     dealer starts the round when the hand begins; bets are accepted until closes_at
//   closed   "no more bets": pressed by the dealer before the burn card, or automatically at closes_at
//   settled  the dealer entered the three flop cards (confirmed by a second person if the table
//            requires it); every bet is paid or lost in one database transaction
//   void     misdeal or incident: every stake goes back
//
// Risk control: for every open round we keep, per currency, the total payout the house would owe
// on each of the 22,100 possible flops. A bet is refused if the worst flop would cost the house
// more than the table's max_round_liability.
//
// Table limits (min/max stake, max payout per bet, max round liability) are amounts in the
// player's own currency and apply to each currency separately: a table with a 10,000 cap
// risks at most 100.00 EUR and 100.00 USD on one hand, never a converted total. There are no
// exchange rates in the system on purpose; set limits with the table's currencies in mind.

import { type Flop, flopIndex, formatCard, parseFlop } from './cards.ts';
import { MARKETS, payoutFor, priceList, priceX100, TOTAL_FLOPS } from './markets.ts';
import type { Db, Row } from './db.ts';
import type { SaferPlay } from './safer.ts';
import type { Ledger } from './ledger.ts';
import type { Audit } from './audit.ts';
import type { Events } from './events.ts';
import type { OperatorRow, SeamlessWallet } from './wallet.ts';
import { fail, int, newId, optStr, str } from './util.ts';

export type TableInput = {
  name: string;
  marginBps?: number;
  minStake?: number;
  maxStake?: number;
  maxBetPayout?: number;
  maxRoundLiability?: number;
  bettingSeconds?: number;
  dualConfirm?: boolean;
  streamUrl?: string | null;
};

type Exposure = { stakes: number; payouts: Float64Array };

export type PlayerRow = { id: string; operator_id: string; external_id: string; display_name: string; status: string };

// Other modules (tournaments) settle their own bets on the same real flop, inside the same
// database transaction. flopIndex is null when the round is voided.
export type RoundHook = (round: Row, flopIndex: number | null, now: number) => Promise<void>;
// Called when a player sits down at a table whose round is still taking bets or being dealt,
// so other modules can cancel that player's bets on the round.
export type SeatHook = (round: Row, playerId: string, now: number) => Promise<number>;

const BET_SELECT = "SELECT b.*, o.wallet_mode, p.external_id FROM bets b JOIN operators o ON o.id = b.operator_id JOIN players p ON p.id = b.player_id";

export class Game {
  readonly roundHooks: RoundHook[] = [];
  readonly seatHooks: SeatHook[] = [];

  private db: Db;
  private ledger: Ledger;
  private audit: Audit;
  private events: Events;
  private wallet: SeamlessWallet;
  private now: () => number;
  readonly safer: SaferPlay;

  constructor(db: Db, ledger: Ledger, audit: Audit, events: Events, wallet: SeamlessWallet, now: () => number, safer: SaferPlay) {
    this.safer = safer;
    this.db = db;
    this.ledger = ledger;
    this.audit = audit;
    this.events = events;
    this.wallet = wallet;
    this.now = now;
  }

  // ---------- tables ----------

  async createTable(input: TableInput, actor: string) {
    const t = this.tableFields(input, {});
    const id = newId('tbl');
    await this.db.tx(async () => {
      await this.db.run(
        `INSERT INTO tables (id, name, margin_bps, min_stake, max_stake, max_bet_payout, max_round_liability, betting_seconds, dual_confirm, stream_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, t.name, t.margin_bps, t.min_stake, t.max_stake, t.max_bet_payout, t.max_round_liability, t.betting_seconds, t.dual_confirm, t.stream_url, this.now(),
      );
      await this.audit.log(actor, 'table.create', { tableId: id, ...t });
    });
    this.events.publish('lobby', 'tables.changed', {});
    return this.table(id);
  }

  async updateTable(id: string, input: Partial<TableInput> & { status?: string }, actor: string) {
    const current = await this.table(id);
    const t = this.tableFields({ name: current.name, ...input }, current);
    const status = input.status === undefined ? current.status : input.status;
    if (status !== 'active' && status !== 'inactive') fail(400, 'BAD_INPUT', 'status must be active or inactive');
    await this.db.tx(async () => {
      await this.db.run(
        `UPDATE tables SET name = ?, status = ?, margin_bps = ?, min_stake = ?, max_stake = ?, max_bet_payout = ?, max_round_liability = ?,
         betting_seconds = ?, dual_confirm = ?, stream_url = ? WHERE id = ?`,
        t.name, status, t.margin_bps, t.min_stake, t.max_stake, t.max_bet_payout, t.max_round_liability, t.betting_seconds, t.dual_confirm, t.stream_url, id,
      );
      await this.audit.log(actor, 'table.update', { tableId: id, status, ...t });
    });
    this.events.publish('lobby', 'tables.changed', {});
    this.events.publish(`table:${id}`, 'table.changed', {});
    return this.table(id);
  }

  private tableFields(input: Partial<TableInput>, cur: Row) {
    const pick = <T>(v: T | undefined, fallback: T) => (v === undefined ? fallback : v);
    const t = {
      name: str(input.name, 'name', 60),
      margin_bps: int(pick(input.marginBps, cur.margin_bps ?? 500), 'marginBps', 0, 3_000),
      min_stake: int(pick(input.minStake, cur.min_stake ?? 100), 'minStake', 1),
      max_stake: int(pick(input.maxStake, cur.max_stake ?? 50_000), 'maxStake', 1),
      max_bet_payout: int(pick(input.maxBetPayout, cur.max_bet_payout ?? 1_000_000), 'maxBetPayout', 1),
      max_round_liability: int(pick(input.maxRoundLiability, cur.max_round_liability ?? 5_000_000), 'maxRoundLiability', 1),
      betting_seconds: int(pick(input.bettingSeconds, cur.betting_seconds ?? 45), 'bettingSeconds', 5, 600),
      dual_confirm: pick(input.dualConfirm, cur.dual_confirm === undefined ? false : !!cur.dual_confirm) ? 1 : 0,
      stream_url: input.streamUrl === undefined ? (cur.stream_url ?? null) : optStr(input.streamUrl, 'streamUrl', 500),
    };
    if (t.min_stake > t.max_stake) fail(400, 'BAD_INPUT', 'minStake cannot exceed maxStake');
    return t;
  }

  async table(id: string): Promise<Row> {
    return (await this.db.get('SELECT * FROM tables WHERE id = ?', id)) ?? fail(404, 'TABLE_NOT_FOUND');
  }

  async listTables(includeInactive = false) {
    const rows = await this.db.all(`SELECT * FROM tables ${includeInactive ? '' : "WHERE status = 'active'"} ORDER BY name`);
    const out = [];
    for (const t of rows) {
      // Like tableView: between hands the last result stays until the dealer opens the next one.
      const round = (await this.currentRound(t.id)) ?? (await this.db.get('SELECT * FROM rounds WHERE table_id = ? ORDER BY number DESC LIMIT 1', t.id));
      // The lobby shows every table live: its odds, the hand in play and the last flops.
      const recent = (await this.db.all("SELECT number, flop FROM rounds WHERE table_id = ? AND status = 'settled' ORDER BY number DESC LIMIT 5", t.id))
        .map((r) => ({ number: r.number, flop: JSON.parse(r.flop) }));
      out.push({
        ...publicTable(t),
        markets: priceList(t.margin_bps).map((m) => ({ id: m.id, name: m.name, oddsX100: m.oddsX100 })),
        round: round ? await this.publicRound(round) : null,
        recent,
      });
    }
    return out;
  }

  // Everything a player screen needs for one table.
  async tableView(tableId: string) {
    const t = await this.table(tableId);
    // Between hands the last result stays on screen until the dealer opens the next round.
    const round = (await this.currentRound(tableId)) ?? (await this.db.get('SELECT * FROM rounds WHERE table_id = ? ORDER BY number DESC LIMIT 1', tableId));
    const history = (await this.db.all("SELECT number, flop, settled_at FROM rounds WHERE table_id = ? AND status = 'settled' ORDER BY number DESC LIMIT 20", tableId))
      .map((r) => { const flop = JSON.parse(r.flop); return { number: r.number, flop, at: r.settled_at, winningMarkets: winningMarkets(flop) }; });
    return {
      table: publicTable(t),
      markets: priceList(t.margin_bps).map(({ houseEdge: _h, ...m }) => m),
      round: round ? await this.publicRound(round) : null,
      history,
      serverTime: this.now(),
    };
  }

  // ---------- seats ----------
  // Staff check players in when they sit down. A seated player cannot bet on that table.

  async seatPlayer(tableId: string, playerId: string, actor: string) {
    await this.table(tableId);
    const player = (await this.db.get<PlayerRow>('SELECT * FROM players WHERE id = ?', playerId)) ?? fail(404, 'PLAYER_NOT_FOUND');
    const now = this.now();
    const cancelled = await this.db.tx(async () => {
      const previous = await this.db.get('SELECT table_id FROM seats WHERE player_id = ?', playerId);
      await this.db.run(
        `INSERT INTO seats (player_id, table_id, seated_at, seated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (player_id) DO UPDATE SET table_id = excluded.table_id, seated_at = excluded.seated_at, seated_by = excluded.seated_by`,
        playerId, tableId, now, actor,
      );
      // Once seated the player may see hole cards, so any bets they already have on the hand
      // being dealt at this table are returned.
      const round = await this.currentRound(tableId);
      let n = 0;
      if (round) {
        // A bet whose wallet debit is still in flight is refunded by placeBet as soon as the
        // debit confirms, because by then the seat below is already recorded.
        const bets = await this.db.all(`${BET_SELECT} WHERE b.round_id = ? AND b.player_id = ? AND b.status = 'open'`, round.id, playerId);
        for (const b of bets) await this.refund(b, round.id, now);
        n = bets.length;
        for (const hook of this.seatHooks) n += await hook(round, playerId, now);
      }
      await this.audit.log(actor, 'seat.take', { tableId, playerId, previousTableId: previous?.table_id ?? null, betsCancelled: n });
      return n;
    });
    this.events.publish(`table:${tableId}`, 'table.changed', {});
    return { tableId, playerId, displayName: player!.display_name, betsCancelled: cancelled };
  }

  async unseatPlayer(tableId: string, playerId: string, actor: string) {
    const seat = (await this.db.get('SELECT * FROM seats WHERE player_id = ? AND table_id = ?', playerId, tableId)) ?? fail(404, 'NOT_SEATED');
    await this.db.tx(async () => {
      await this.db.run('DELETE FROM seats WHERE player_id = ?', playerId);
      await this.audit.log(actor, 'seat.leave', { tableId, playerId, seatedFor: this.now() - seat!.seated_at });
    });
    this.events.publish(`table:${tableId}`, 'table.changed', {});
    return { ok: true };
  }

  seats(tableId: string) {
    return this.db.all(
      `SELECT s.player_id AS "playerId", p.display_name AS "displayName", l.username, o.name AS operator, s.seated_at AS "seatedAt"
       FROM seats s JOIN players p ON p.id = s.player_id JOIN operators o ON o.id = p.operator_id LEFT JOIN player_logins l ON l.player_id = p.id
       WHERE s.table_id = ? ORDER BY s.seated_at`,
      tableId,
    );
  }

  async seatOf(playerId: string): Promise<string | null> {
    return (await this.db.get<{ table_id: string }>('SELECT table_id FROM seats WHERE player_id = ?', playerId))?.table_id ?? null;
  }

  async assertNotSeated(tableId: string, playerId: string) {
    if ((await this.seatOf(playerId)) === tableId)
      fail(403, 'SEATED_AT_TABLE', "You're playing at this table, so you can't bet on its flop. Bet on another table.");
  }

  // ---------- rounds ----------

  currentRound(tableId: string): Promise<Row | undefined> {
    return this.db.get("SELECT * FROM rounds WHERE table_id = ? AND status IN ('open','closed') ORDER BY number DESC LIMIT 1", tableId);
  }

  async round(id: string): Promise<Row> {
    return (await this.db.get('SELECT * FROM rounds WHERE id = ?', id)) ?? fail(404, 'ROUND_NOT_FOUND');
  }

  async publicRound(r: Row) {
    const counts = await this.db.all(
      "SELECT market_id, COUNT(*) AS n FROM bets WHERE round_id = ? AND status IN ('pending','open','won','lost') GROUP BY market_id",
      r.id,
    );
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      openedAt: r.opened_at,
      closesAt: r.status === 'open' ? r.closes_at : r.closed_at,
      flop: r.flop ? JSON.parse(r.flop) : null,
      winningMarkets: r.flop ? winningMarkets(JSON.parse(r.flop)) : [],
      awaitingConfirmation: !!r.pending_flop,
      betsByMarket: Object.fromEntries(counts.map((c) => [c.market_id, c.n])),
    };
  }

  async openRound(tableId: string, actor: string) {
    const id = newId('rnd');
    await this.db.tx(async () => {
      const t = await this.table(tableId);
      if (t.status !== 'active') fail(409, 'TABLE_INACTIVE');
      if (await this.currentRound(tableId)) fail(409, 'ROUND_IN_PROGRESS', 'Finish or void the current round first');
      const number = ((await this.db.get<{ n: number }>('SELECT MAX(number) AS n FROM rounds WHERE table_id = ?', tableId))?.n ?? 0) + 1;
      const now = this.now();
      await this.db.run(
        "INSERT INTO rounds (id, table_id, number, status, opened_at, closes_at, opened_by) VALUES (?, ?, ?, 'open', ?, ?, ?)",
        id, tableId, number, now, now + t.betting_seconds * 1000, actor,
      );
      await this.audit.log(actor, 'round.open', { tableId, roundId: id, number });
    });
    return this.emitRound(tableId, 'round.opened', id);
  }

  async closeRound(roundId: string, actor: string) {
    const r = await this.db.tx(async () => {
      const r = await this.round(roundId);
      if (r.status !== 'open') fail(409, 'ROUND_NOT_OPEN');
      await this.db.run("UPDATE rounds SET status = 'closed', closed_at = ? WHERE id = ?", Math.min(this.now(), r.closes_at), roundId);
      await this.audit.log(actor, 'round.close', { tableId: r.table_id, roundId });
      return r;
    });
    return this.emitRound(r.table_id, 'round.closed', roundId);
  }

  // Auto-close rounds whose betting window has run out. Called by a timer (or on each request
  // when hosted without background timers).
  async tick() {
    for (const r of await this.db.all("SELECT id FROM rounds WHERE status = 'open' AND closes_at <= ?", this.now())) {
      try {
        await this.closeRound(r.id, 'system');
      } catch (e: any) {
        if (e?.code !== 'ROUND_NOT_OPEN') throw e; // another copy of the app closed it first
      }
    }
  }

  // The dealer (and, on dual-confirm tables, a second staff member) enters the flop.
  async submitFlop(roundId: string, cards: unknown, actor: string) {
    let flop: Flop;
    try { flop = parseFlop(cards); } catch (e: any) { return fail(400, 'BAD_FLOP', e.message); }
    const text = JSON.stringify(flop.map(formatCard));
    const result = await this.db.tx(async () => {
      const r = await this.round(roundId);
      if (r.status === 'open') fail(409, 'ROUND_STILL_OPEN', 'Close betting before the flop is dealt');
      if (r.status !== 'closed') fail(409, 'ROUND_FINISHED');
      const t = await this.table(r.table_id);
      if (t.dual_confirm) {
        if (!r.pending_flop) {
          await this.db.run('UPDATE rounds SET pending_flop = ?, pending_by = ? WHERE id = ?', text, actor, roundId);
          await this.audit.log(actor, 'round.flop_entered', { roundId, flop: JSON.parse(text) });
          return { r, outcome: 'pending' as const };
        }
        if (r.pending_by === actor) fail(409, 'NEEDS_SECOND_PERSON', 'A different staff member must confirm the flop');
        if (!sameFlop(r.pending_flop, text)) {
          await this.db.run('UPDATE rounds SET pending_flop = NULL, pending_by = NULL WHERE id = ?', roundId);
          await this.audit.log(actor, 'round.flop_mismatch', { roundId, first: JSON.parse(r.pending_flop), second: JSON.parse(text), firstBy: r.pending_by });
          return { r, outcome: 'mismatch' as const };
        }
      }
      await this.settle(r, flop, actor);
      return { r, outcome: 'settled' as const };
    });
    const { r, outcome } = result;
    if (outcome === 'pending') {
      await this.emitRound(r.table_id, 'round.flop_pending', roundId);
      return { settled: false, awaitingConfirmation: true };
    }
    if (outcome === 'mismatch') {
      await this.emitRound(r.table_id, 'round.flop_mismatch', roundId);
      fail(409, 'FLOP_MISMATCH', 'The two entries differ. Both people must enter the flop again.');
    }
    await this.emitRound(r.table_id, 'round.settled', roundId);
    return { settled: true, awaitingConfirmation: false };
  }

  // Runs inside submitFlop's transaction.
  private async settle(r: Row, flop: Flop, actor: string) {
    const idx = flopIndex(flop);
    const cards = flop.map(formatCard);
    const now = this.now();
    if (await this.db.get("SELECT 1 FROM bets WHERE round_id = ? AND status = 'pending'", r.id))
      fail(409, 'BETS_PENDING', 'Wallet confirmations are still in flight, retry in a moment');
    const bets = await this.db.all(`${BET_SELECT} WHERE b.round_id = ? AND b.status = 'open'`, r.id);
    let stakes = 0;
    let payouts = 0;
    for (const b of bets) {
      const won = MARKETS.get(b.market_id)!.wins[idx] === 1;
      const payout = won ? payoutFor(b.stake, b.odds_x100) : 0;
      const ggr = `ggr:${b.operator_id}`;
      const entries = [{ account: `escrow:${r.id}`, amount: -b.stake }, { account: ggr, amount: b.stake - payout }];
      if (payout > 0) entries.push({ account: walletAccount(b), amount: payout });
      await this.ledger.post('settle', b.id, b.currency, entries);
      if (payout > 0 && b.wallet_mode === 'seamless')
        await this.wallet.enqueue(b.operator_id, 'credit', creditPayload(b, payout, 'win', r.id));
      await this.db.run('UPDATE bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?', won ? 'won' : 'lost', payout, now, b.id);
      stakes += b.stake;
      payouts += payout;
    }
    for (const hook of this.roundHooks) await hook(r, idx, now);
    await this.db.run("UPDATE rounds SET status = 'settled', flop = ?, settled_at = ?, pending_flop = NULL WHERE id = ?", JSON.stringify(cards), now, r.id);
    await this.audit.log(actor, 'round.settle', { tableId: r.table_id, roundId: r.id, flop: cards, confirmedAfter: r.pending_by ?? null, bets: bets.length, stakes, payouts });
    return { bets: bets.length, stakes, payouts };
  }

  async voidRound(roundId: string, reason: unknown, actor: string) {
    const why = str(reason, 'reason', 300);
    const now = this.now();
    const r = await this.db.tx(async () => {
      const r = await this.round(roundId);
      if (r.status !== 'open' && r.status !== 'closed') fail(409, 'ROUND_FINISHED', 'Only an open or closed round can be voided');
      if (await this.db.get("SELECT 1 FROM bets WHERE round_id = ? AND status = 'pending'", r.id))
        fail(409, 'BETS_PENDING', 'Wallet confirmations are still in flight, retry in a moment');
      const bets = await this.db.all(`${BET_SELECT} WHERE b.round_id = ? AND b.status = 'open'`, r.id);
      for (const b of bets) await this.refund(b, r.id, now);
      for (const hook of this.roundHooks) await hook(r, null, now);
      await this.db.run("UPDATE rounds SET status = 'void', void_reason = ?, closed_at = COALESCE(closed_at, ?), pending_flop = NULL WHERE id = ?", why, now, r.id);
      await this.audit.log(actor, 'round.void', { tableId: r.table_id, roundId: r.id, reason: why, refunded: bets.length });
      return r;
    });
    return this.emitRound(r.table_id, 'round.voided', r.id);
  }

  private async refund(b: Row, roundId: string, now: number) {
    await this.ledger.transfer('refund', b.id, b.currency, `escrow:${roundId}`, walletAccount(b), b.stake);
    if (b.wallet_mode === 'seamless') await this.wallet.enqueue(b.operator_id, 'credit', creditPayload(b, b.stake, 'refund', roundId));
    await this.db.run("UPDATE bets SET status = 'refunded', payout = ?, settled_at = ? WHERE id = ?", b.stake, now, b.id);
  }

  private async emitRound(tableId: string, event: string, roundId: string) {
    const view = await this.publicRound(await this.round(roundId));
    this.events.publish(`table:${tableId}`, event, view);
    this.events.publish('lobby', 'tables.changed', {});
    return view;
  }

  // ---------- bets ----------

  async placeBet(player: PlayerRow, input: { roundId?: unknown; marketId?: unknown; stake?: unknown; clientRef?: unknown }) {
    const clientRef = optStr(input.clientRef, 'clientRef', 64);
    if (clientRef) {
      const prior = await this.db.get('SELECT * FROM bets WHERE player_id = ? AND client_ref = ?', player.id, clientRef);
      if (prior) return publicBet(prior); // retried request: same answer, no second bet
    }
    const roundId = str(input.roundId, 'roundId', 64);
    const market = MARKETS.get(str(input.marketId, 'marketId', 40)) ?? fail(400, 'UNKNOWN_MARKET');
    const stake = int(input.stake, 'stake', 1);
    const betId = newId('bet');

    // Everything that decides whether the bet is allowed (round still open, not seated, limits,
    // the table's worst-flop risk) is checked in the same transaction that records the bet.
    const { op, r } = await this.db.tx(async () => {
      const op = (await this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', player.operator_id))!;
      if (op.status !== 'active') fail(403, 'OPERATOR_SUSPENDED');
      const fresh = await this.db.get<PlayerRow>('SELECT status FROM players WHERE id = ?', player.id);
      if (fresh?.status !== 'active') fail(403, 'PLAYER_BLOCKED');
      await this.safer.assertCanPlay(player, stake, op.currency);
      const r = await this.round(roundId);
      if (r.status !== 'open' || this.now() >= r.closes_at) fail(409, 'BETTING_CLOSED');
      await this.assertNotSeated(r.table_id, player.id);
      const t = await this.table(r.table_id);
      if (t.status !== 'active') fail(409, 'TABLE_INACTIVE');
      const odds = priceX100(market, t.margin_bps) ?? fail(400, 'MARKET_NOT_OFFERED');
      if (stake < t.min_stake || stake > t.max_stake) fail(400, 'STAKE_OUT_OF_RANGE', `Stake must be between ${t.min_stake} and ${t.max_stake}`);
      const payout = payoutFor(stake, odds!);
      if (payout > t.max_bet_payout) fail(400, 'PAYOUT_LIMIT', `Maximum payout per bet is ${t.max_bet_payout}`);
      // Liability is capped per currency (see the note at the top of this file). Pending
      // seamless bets count, so parallel bets cannot overshoot the limit.
      if (worstCaseAfter(await this.exposureFor(r.id, op.currency), market.wins, stake, payout) > t.max_round_liability)
        fail(409, 'TABLE_LIMIT_REACHED', 'This market is full for this round, try a smaller stake or another market');
      await this.db.run(
        'INSERT INTO bets (id, round_id, player_id, operator_id, market_id, currency, stake, odds_x100, status, placed_at, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        betId, r.id, player.id, op.id, market.id, op.currency, stake, odds, op.wallet_mode === 'transfer' ? 'open' : 'pending', this.now(), clientRef,
      );
      if (op.wallet_mode === 'transfer') await this.ledger.transfer('bet', betId, op.currency, `player:${player.id}`, `escrow:${r.id}`, stake);
      return { op, r };
    });

    if (op.wallet_mode === 'seamless') {
      const bet = { id: betId, round_id: r.id, player_id: player.id, operator_id: op.id, market_id: market.id, currency: op.currency, stake, wallet_mode: op.wallet_mode, external_id: player.external_id };
      const res = await this.wallet.call(op, 'debit', {
        txId: `${betId}:debit`, playerId: player.external_id, amount: stake, currency: op.currency, roundId: r.id, betId, marketId: market.id,
      });
      if (res.ok) {
        // The player may have been checked in at this table while the debit was in flight.
        const seatedNow = await this.db.tx(async () => {
          await this.db.run("UPDATE bets SET status = 'open' WHERE id = ?", betId);
          await this.ledger.transfer('bet', betId, op.currency, `seamless:${op.id}`, `escrow:${r.id}`, stake);
          const seated = (await this.seatOf(player.id)) === r.table_id;
          if (seated) {
            await this.refund(bet, r.id, this.now());
            await this.audit.log('system', 'bet.refund_seated', { betId, playerId: player.id, tableId: r.table_id });
          }
          return seated;
        });
        if (seatedNow) await this.assertNotSeated(r.table_id, player.id);
      } else {
        await this.db.tx(async () => {
          await this.db.run("UPDATE bets SET status = 'rejected' WHERE id = ?", betId);
          if (res.uncertain)
            await this.wallet.enqueue(op.id, 'rollback', { txId: `${betId}:rollback`, originalTxId: `${betId}:debit`, playerId: player.external_id, amount: stake, currency: op.currency, betId });
        });
        fail(res.code === 'INSUFFICIENT_FUNDS' ? 402 : 502, res.code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_FUNDS' : 'WALLET_ERROR', res.code);
      }
    }
    const view = await this.publicRound(await this.round(r.id));
    this.events.publish(`table:${r.table_id}`, 'round.bets', { id: r.id, betsByMarket: view.betsByMarket });
    return publicBet((await this.db.get('SELECT * FROM bets WHERE id = ?', betId))!);
  }

  async playerBets(playerId: string, limit = 50) {
    return (await this.db.all(
      `SELECT b.*, r.number AS round_number, r.flop, r.table_id, t.name AS table_name FROM bets b
       JOIN rounds r ON r.id = b.round_id JOIN tables t ON t.id = r.table_id
       WHERE b.player_id = ? AND b.status != 'rejected' ORDER BY b.placed_at DESC LIMIT ?`,
      playerId, limit,
    )).map((b) => ({ ...publicBet(b), roundNumber: b.round_number, tableId: b.table_id, tableName: b.table_name, flop: b.flop ? JSON.parse(b.flop) : null }));
  }

  // Worst case for the house on the current round, for the dealer/supervisor screen.
  async roundRisk(roundId: string) {
    const out: Record<string, { stakes: number; worstCase: number }> = {};
    const currencies = await this.db.all('SELECT DISTINCT currency FROM bets WHERE round_id = ?', roundId);
    for (const { currency } of currencies) {
      const e = await this.exposureFor(roundId, currency);
      out[currency] = { stakes: e.stakes, worstCase: worstCaseAfter(e, null, 0, 0) };
    }
    return out;
  }

  // What the house would pay on each of the 22,100 flops for the live bets of a round, computed
  // from the database so every copy of the app sees the same numbers.
  private async exposureFor(roundId: string, currency: string): Promise<Exposure> {
    const e = { stakes: 0, payouts: new Float64Array(TOTAL_FLOPS) };
    const live = await this.db.all(
      "SELECT market_id, stake, odds_x100 FROM bets WHERE round_id = ? AND currency = ? AND status IN ('pending','open')",
      roundId, currency,
    );
    const byMarket = new Map<string, { stake: number; payout: number }>();
    for (const b of live) {
      const m = byMarket.get(b.market_id) ?? { stake: 0, payout: 0 };
      m.stake += b.stake;
      m.payout += payoutFor(b.stake, b.odds_x100);
      byMarket.set(b.market_id, m);
    }
    for (const [marketId, m] of byMarket) applyExposure(e, MARKETS.get(marketId)!.wins, m.stake, m.payout, 1);
    return e;
  }
}

function applyExposure(e: Exposure, wins: Uint8Array, stake: number, payout: number, sign: 1 | -1) {
  e.stakes += sign * stake;
  const p = payout * sign;
  for (let i = 0; i < TOTAL_FLOPS; i++) if (wins[i]) e.payouts[i] += p;
}

// House loss on the worst possible flop, if this bet were added.
function worstCaseAfter(e: Exposure, wins: Uint8Array | null, stake: number, payout: number): number {
  let worst = -Infinity;
  for (let i = 0; i < TOTAL_FLOPS; i++) {
    const v = e.payouts[i] + (wins && wins[i] ? payout : 0);
    if (v > worst) worst = v;
  }
  return worst - (e.stakes + stake);
}

function winningMarkets(cards: string[]) {
  const idx = flopIndex(parseFlop(cards));
  return [...MARKETS.values()].filter((m) => m.wins[idx] === 1).map((m) => m.id);
}

const sameFlop = (a: string, b: string) => JSON.stringify(JSON.parse(a).sort()) === JSON.stringify(JSON.parse(b).sort());

const walletAccount = (b: Row) => (b.wallet_mode === 'seamless' ? `seamless:${b.operator_id}` : `player:${b.player_id}`);

function creditPayload(b: Row, amount: number, reason: 'win' | 'refund', roundId: string) {
  return { txId: `${b.id}:${reason}`, playerId: b.external_id, amount, currency: b.currency, roundId, betId: b.id, reason };
}

export function publicTable(t: Row) {
  return {
    id: t.id, name: t.name, status: t.status, marginBps: t.margin_bps, minStake: t.min_stake, maxStake: t.max_stake,
    maxBetPayout: t.max_bet_payout, maxRoundLiability: t.max_round_liability, bettingSeconds: t.betting_seconds,
    dualConfirm: !!t.dual_confirm, streamUrl: t.stream_url,
  };
}

export function publicBet(b: Row) {
  return {
    id: b.id, roundId: b.round_id, marketId: b.market_id, currency: b.currency, stake: b.stake, oddsX100: b.odds_x100,
    potentialPayout: payoutFor(b.stake, b.odds_x100), status: b.status, payout: b.payout, placedAt: b.placed_at, settledAt: b.settled_at ?? null,
  };
}
