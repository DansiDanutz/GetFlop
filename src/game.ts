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

import { type Flop, flopIndex, formatCard, parseFlop } from './cards.ts';
import { MARKETS, payoutFor, priceList, priceX100, TOTAL_FLOPS } from './markets.ts';
import type { Db, Row } from './db.ts';
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
export type RoundHook = (round: Row, flopIndex: number | null, now: number) => void;

export class Game {
  readonly roundHooks: RoundHook[] = [];
  // roundId -> currency -> exposure. Rebuilt from the database on demand after a restart.
  private exposure = new Map<string, Map<string, Exposure>>();

  private db: Db;
  private ledger: Ledger;
  private audit: Audit;
  private events: Events;
  private wallet: SeamlessWallet;
  private now: () => number;

  constructor(db: Db, ledger: Ledger, audit: Audit, events: Events, wallet: SeamlessWallet, now: () => number) {
    this.db = db;
    this.ledger = ledger;
    this.audit = audit;
    this.events = events;
    this.wallet = wallet;
    this.now = now;
  }

  // ---------- tables ----------

  createTable(input: TableInput, actor: string) {
    const t = this.tableFields(input, {});
    const id = newId('tbl');
    this.db.run(
      `INSERT INTO tables (id, name, margin_bps, min_stake, max_stake, max_bet_payout, max_round_liability, betting_seconds, dual_confirm, stream_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, t.name, t.margin_bps, t.min_stake, t.max_stake, t.max_bet_payout, t.max_round_liability, t.betting_seconds, t.dual_confirm, t.stream_url, this.now(),
    );
    this.audit.log(actor, 'table.create', { tableId: id, ...t });
    this.events.publish('lobby', 'tables.changed', {});
    return this.table(id);
  }

  updateTable(id: string, input: Partial<TableInput> & { status?: string }, actor: string) {
    const current = this.table(id);
    const t = this.tableFields({ name: current.name, ...input }, current);
    const status = input.status === undefined ? current.status : input.status;
    if (status !== 'active' && status !== 'inactive') fail(400, 'BAD_INPUT', 'status must be active or inactive');
    this.db.run(
      `UPDATE tables SET name = ?, status = ?, margin_bps = ?, min_stake = ?, max_stake = ?, max_bet_payout = ?, max_round_liability = ?,
       betting_seconds = ?, dual_confirm = ?, stream_url = ? WHERE id = ?`,
      t.name, status, t.margin_bps, t.min_stake, t.max_stake, t.max_bet_payout, t.max_round_liability, t.betting_seconds, t.dual_confirm, t.stream_url, id,
    );
    this.audit.log(actor, 'table.update', { tableId: id, status, ...t });
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

  table(id: string): Row {
    return this.db.get('SELECT * FROM tables WHERE id = ?', id) ?? fail(404, 'TABLE_NOT_FOUND');
  }

  listTables(includeInactive = false) {
    const rows = this.db.all(`SELECT * FROM tables ${includeInactive ? '' : "WHERE status = 'active'"} ORDER BY name`);
    return rows.map((t) => {
      const round = this.currentRound(t.id);
      return { ...publicTable(t), round: round ? this.publicRound(round) : null };
    });
  }

  // Everything a player screen needs for one table.
  tableView(tableId: string) {
    const t = this.table(tableId);
    const round = this.currentRound(tableId);
    const history = this.db
      .all("SELECT number, flop, settled_at FROM rounds WHERE table_id = ? AND status = 'settled' ORDER BY number DESC LIMIT 20", tableId)
      .map((r) => ({ number: r.number, flop: JSON.parse(r.flop), at: r.settled_at }));
    return {
      table: publicTable(t),
      markets: priceList(t.margin_bps).map(({ houseEdge: _h, ...m }) => m),
      round: round ? this.publicRound(round) : null,
      history,
      serverTime: this.now(),
    };
  }

  // ---------- rounds ----------

  currentRound(tableId: string): Row | undefined {
    return this.db.get("SELECT * FROM rounds WHERE table_id = ? AND status IN ('open','closed') ORDER BY number DESC LIMIT 1", tableId);
  }

  round(id: string): Row {
    return this.db.get('SELECT * FROM rounds WHERE id = ?', id) ?? fail(404, 'ROUND_NOT_FOUND');
  }

  publicRound(r: Row) {
    const counts = this.db.all(
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
      awaitingConfirmation: !!r.pending_flop,
      betsByMarket: Object.fromEntries(counts.map((c) => [c.market_id, c.n])),
    };
  }

  openRound(tableId: string, actor: string) {
    const t = this.table(tableId);
    if (t.status !== 'active') fail(409, 'TABLE_INACTIVE');
    if (this.currentRound(tableId)) fail(409, 'ROUND_IN_PROGRESS', 'Finish or void the current round first');
    const number = (this.db.get<{ n: number }>('SELECT MAX(number) AS n FROM rounds WHERE table_id = ?', tableId)?.n ?? 0) + 1;
    const id = newId('rnd');
    const now = this.now();
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO rounds (id, table_id, number, status, opened_at, closes_at, opened_by) VALUES (?, ?, ?, 'open', ?, ?, ?)",
        id, tableId, number, now, now + t.betting_seconds * 1000, actor,
      );
      this.audit.log(actor, 'round.open', { tableId, roundId: id, number });
    });
    return this.emitRound(tableId, 'round.opened', id);
  }

  closeRound(roundId: string, actor: string) {
    const r = this.round(roundId);
    if (r.status !== 'open') fail(409, 'ROUND_NOT_OPEN');
    const now = Math.min(this.now(), r.closes_at);
    this.db.tx(() => {
      this.db.run("UPDATE rounds SET status = 'closed', closed_at = ? WHERE id = ?", now, roundId);
      this.audit.log(actor, 'round.close', { tableId: r.table_id, roundId });
    });
    return this.emitRound(r.table_id, 'round.closed', roundId);
  }

  // Auto-close rounds whose betting window has run out. Called by a timer every 250 ms.
  tick() {
    for (const r of this.db.all("SELECT id FROM rounds WHERE status = 'open' AND closes_at <= ?", this.now())) {
      this.closeRound(r.id, 'system');
    }
  }

  // The dealer (and, on dual-confirm tables, a second staff member) enters the flop.
  submitFlop(roundId: string, cards: unknown, actor: string) {
    const r = this.round(roundId);
    if (r.status === 'open') fail(409, 'ROUND_STILL_OPEN', 'Close betting before the flop is dealt');
    if (r.status !== 'closed') fail(409, 'ROUND_FINISHED');
    let flop: Flop;
    try { flop = parseFlop(cards); } catch (e: any) { return fail(400, 'BAD_FLOP', e.message); }
    const text = JSON.stringify(flop.map(formatCard));
    const t = this.table(r.table_id);

    if (t.dual_confirm) {
      if (!r.pending_flop) {
        this.db.tx(() => {
          this.db.run('UPDATE rounds SET pending_flop = ?, pending_by = ? WHERE id = ?', text, actor, roundId);
          this.audit.log(actor, 'round.flop_entered', { roundId, flop: JSON.parse(text) });
        });
        this.emitRound(r.table_id, 'round.flop_pending', roundId);
        return { settled: false, awaitingConfirmation: true };
      }
      if (r.pending_by === actor) fail(409, 'NEEDS_SECOND_PERSON', 'A different staff member must confirm the flop');
      if (sameFlop(r.pending_flop, text) === false) {
        this.db.tx(() => {
          this.db.run('UPDATE rounds SET pending_flop = NULL, pending_by = NULL WHERE id = ?', roundId);
          this.audit.log(actor, 'round.flop_mismatch', { roundId, first: JSON.parse(r.pending_flop), second: JSON.parse(text), firstBy: r.pending_by });
        });
        this.emitRound(r.table_id, 'round.flop_mismatch', roundId);
        fail(409, 'FLOP_MISMATCH', 'The two entries differ. Both people must enter the flop again.');
      }
    }
    this.settle(r, flop, actor);
    return { settled: true, awaitingConfirmation: false };
  }

  private settle(r: Row, flop: Flop, actor: string) {
    const idx = flopIndex(flop);
    const cards = flop.map(formatCard);
    const now = this.now();
    const summary = this.db.tx(() => {
      if (this.db.get("SELECT 1 FROM bets WHERE round_id = ? AND status = 'pending'", r.id))
        fail(409, 'BETS_PENDING', 'Wallet confirmations are still in flight, retry in a moment');
      const bets = this.db.all("SELECT b.*, o.wallet_mode, p.external_id FROM bets b JOIN operators o ON o.id = b.operator_id JOIN players p ON p.id = b.player_id WHERE b.round_id = ? AND b.status = 'open'", r.id);
      let stakes = 0;
      let payouts = 0;
      for (const b of bets) {
        const won = MARKETS.get(b.market_id)!.wins[idx] === 1;
        const payout = won ? payoutFor(b.stake, b.odds_x100) : 0;
        const ggr = `ggr:${b.operator_id}`;
        const entries = [{ account: `escrow:${r.id}`, amount: -b.stake }, { account: ggr, amount: b.stake - payout }];
        if (payout > 0) entries.push({ account: walletAccount(b), amount: payout });
        this.ledger.post('settle', b.id, b.currency, entries);
        if (payout > 0 && b.wallet_mode === 'seamless')
          this.wallet.enqueue(b.operator_id, 'credit', creditPayload(b, payout, 'win', r.id));
        this.db.run('UPDATE bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?', won ? 'won' : 'lost', payout, now, b.id);
        stakes += b.stake;
        payouts += payout;
      }
      for (const hook of this.roundHooks) hook(r, idx, now);
      this.db.run("UPDATE rounds SET status = 'settled', flop = ?, settled_at = ?, pending_flop = NULL WHERE id = ?", JSON.stringify(cards), now, r.id);
      this.audit.log(actor, 'round.settle', { tableId: r.table_id, roundId: r.id, flop: cards, confirmedAfter: r.pending_by ?? null, bets: bets.length, stakes, payouts });
      return { bets: bets.length, stakes, payouts };
    });
    this.exposure.delete(r.id);
    this.emitRound(r.table_id, 'round.settled', r.id);
    return summary;
  }

  voidRound(roundId: string, reason: unknown, actor: string) {
    const r = this.round(roundId);
    if (r.status !== 'open' && r.status !== 'closed') fail(409, 'ROUND_FINISHED', 'Only an open or closed round can be voided');
    const why = str(reason, 'reason', 300);
    const now = this.now();
    this.db.tx(() => {
      if (this.db.get("SELECT 1 FROM bets WHERE round_id = ? AND status = 'pending'", r.id))
        fail(409, 'BETS_PENDING', 'Wallet confirmations are still in flight, retry in a moment');
      const bets = this.db.all("SELECT b.*, o.wallet_mode, p.external_id FROM bets b JOIN operators o ON o.id = b.operator_id JOIN players p ON p.id = b.player_id WHERE b.round_id = ? AND b.status = 'open'", r.id);
      for (const b of bets) this.refund(b, r.id, now);
      for (const hook of this.roundHooks) hook(r, null, now);
      this.db.run("UPDATE rounds SET status = 'void', void_reason = ?, closed_at = COALESCE(closed_at, ?), pending_flop = NULL WHERE id = ?", why, now, r.id);
      this.audit.log(actor, 'round.void', { tableId: r.table_id, roundId: r.id, reason: why, refunded: bets.length });
    });
    this.exposure.delete(r.id);
    return this.emitRound(r.table_id, 'round.voided', r.id);
  }

  private refund(b: Row, roundId: string, now: number) {
    this.ledger.transfer('refund', b.id, b.currency, `escrow:${roundId}`, walletAccount(b), b.stake);
    if (b.wallet_mode === 'seamless') this.wallet.enqueue(b.operator_id, 'credit', creditPayload(b, b.stake, 'refund', roundId));
    this.db.run("UPDATE bets SET status = 'refunded', payout = ?, settled_at = ? WHERE id = ?", b.stake, now, b.id);
  }

  private emitRound(tableId: string, event: string, roundId: string) {
    const view = this.publicRound(this.round(roundId));
    this.events.publish(`table:${tableId}`, event, view);
    this.events.publish('lobby', 'tables.changed', {});
    return view;
  }

  // ---------- bets ----------

  async placeBet(player: PlayerRow, input: { roundId?: unknown; marketId?: unknown; stake?: unknown; clientRef?: unknown }) {
    const clientRef = optStr(input.clientRef, 'clientRef', 64);
    if (clientRef) {
      const prior = this.db.get('SELECT * FROM bets WHERE player_id = ? AND client_ref = ?', player.id, clientRef);
      if (prior) return publicBet(prior); // retried request: same answer, no second bet
    }
    const op = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', player.operator_id)!;
    if (op.status !== 'active') fail(403, 'OPERATOR_SUSPENDED');
    if (player.status !== 'active') fail(403, 'PLAYER_BLOCKED');

    const r = this.round(str(input.roundId, 'roundId', 64));
    if (r.status !== 'open' || this.now() >= r.closes_at) fail(409, 'BETTING_CLOSED');
    const t = this.table(r.table_id);
    if (t.status !== 'active') fail(409, 'TABLE_INACTIVE');
    const market = MARKETS.get(str(input.marketId, 'marketId', 40)) ?? fail(400, 'UNKNOWN_MARKET');
    const odds = priceX100(market, t.margin_bps) ?? fail(400, 'MARKET_NOT_OFFERED');
    const stake = int(input.stake, 'stake', 1);
    if (stake < t.min_stake || stake > t.max_stake) fail(400, 'STAKE_OUT_OF_RANGE', `Stake must be between ${t.min_stake} and ${t.max_stake}`);
    const payout = payoutFor(stake, odds);
    if (payout > t.max_bet_payout) fail(400, 'PAYOUT_LIMIT', `Maximum payout per bet is ${t.max_bet_payout}`);

    const exposure = this.exposureFor(r.id, op.currency);
    if (worstCaseAfter(exposure, market.wins, stake, payout) > t.max_round_liability)
      fail(409, 'TABLE_LIMIT_REACHED', 'This market is full for this round, try a smaller stake or another market');

    const bet = { id: newId('bet'), round_id: r.id, player_id: player.id, operator_id: op.id, market_id: market.id, currency: op.currency, stake, odds_x100: odds, wallet_mode: op.wallet_mode };
    const insert = (status: string) =>
      this.db.run(
        'INSERT INTO bets (id, round_id, player_id, operator_id, market_id, currency, stake, odds_x100, status, placed_at, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        bet.id, r.id, player.id, op.id, market.id, op.currency, stake, odds, status, this.now(), clientRef,
      );

    if (op.wallet_mode === 'transfer') {
      this.db.tx(() => {
        insert('open');
        this.ledger.transfer('bet', bet.id, op.currency, `player:${player.id}`, `escrow:${r.id}`, stake);
      });
      applyExposure(exposure, market.wins, stake, payout, 1);
    } else {
      // Reserve the exposure before the network call so parallel bets cannot overshoot the limit.
      insert('pending');
      applyExposure(exposure, market.wins, stake, payout, 1);
      const res = await this.wallet.call(op, 'debit', {
        txId: `${bet.id}:debit`, playerId: player.external_id, amount: stake, currency: op.currency, roundId: r.id, betId: bet.id, marketId: market.id,
      });
      if (res.ok) {
        this.db.tx(() => {
          this.db.run("UPDATE bets SET status = 'open' WHERE id = ?", bet.id);
          this.ledger.transfer('bet', bet.id, op.currency, `seamless:${op.id}`, `escrow:${r.id}`, stake);
        });
      } else {
        applyExposure(exposure, market.wins, stake, payout, -1);
        this.db.tx(() => {
          this.db.run("UPDATE bets SET status = 'rejected' WHERE id = ?", bet.id);
          if (res.uncertain)
            this.wallet.enqueue(op.id, 'rollback', { txId: `${bet.id}:rollback`, originalTxId: `${bet.id}:debit`, playerId: player.external_id, amount: stake, currency: op.currency, betId: bet.id });
        });
        fail(res.code === 'INSUFFICIENT_FUNDS' ? 402 : 502, res.code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_FUNDS' : 'WALLET_ERROR', res.code);
      }
    }
    const view = this.publicRound(this.round(r.id));
    this.events.publish(`table:${r.table_id}`, 'round.bets', { id: r.id, betsByMarket: view.betsByMarket });
    return publicBet(this.db.get('SELECT * FROM bets WHERE id = ?', bet.id)!);
  }

  playerBets(playerId: string, limit = 50) {
    return this.db
      .all(
        `SELECT b.*, r.number AS round_number, r.flop, r.table_id, t.name AS table_name FROM bets b
         JOIN rounds r ON r.id = b.round_id JOIN tables t ON t.id = r.table_id
         WHERE b.player_id = ? AND b.status != 'rejected' ORDER BY b.placed_at DESC LIMIT ?`,
        playerId, limit,
      )
      .map((b) => ({ ...publicBet(b), roundNumber: b.round_number, tableId: b.table_id, tableName: b.table_name, flop: b.flop ? JSON.parse(b.flop) : null }));
  }

  // Worst case for the house on the current round, for the dealer/supervisor screen.
  roundRisk(roundId: string) {
    const out: Record<string, { stakes: number; worstCase: number }> = {};
    const currencies = this.db.all('SELECT DISTINCT currency FROM bets WHERE round_id = ?', roundId);
    for (const { currency } of currencies) {
      const e = this.exposureFor(roundId, currency);
      out[currency] = { stakes: e.stakes, worstCase: worstCaseAfter(e, null, 0, 0) };
    }
    return out;
  }

  private exposureFor(roundId: string, currency: string): Exposure {
    let byCurrency = this.exposure.get(roundId);
    if (!byCurrency) this.exposure.set(roundId, (byCurrency = new Map()));
    let e = byCurrency.get(currency);
    if (!e) {
      e = { stakes: 0, payouts: new Float64Array(TOTAL_FLOPS) };
      const live = this.db.all("SELECT market_id, stake, odds_x100 FROM bets WHERE round_id = ? AND currency = ? AND status IN ('pending','open')", roundId, currency);
      for (const b of live) applyExposure(e, MARKETS.get(b.market_id)!.wins, b.stake, payoutFor(b.stake, b.odds_x100), 1);
      byCurrency.set(currency, e);
    }
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
