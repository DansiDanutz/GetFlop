// Tournaments: everyone gets the same tournament points, bets them on real flops, and the
// leaderboard at the end decides who shares the prize pool.
//
// The rules of a tournament come from a *strategy*. The engine below handles what every
// tournament shares (sign-up, buy-ins, the prize pool, betting on live rounds, settlement,
// payouts); a strategy decides the specifics: starting points, which bets are allowed,
// how the leaderboard is ordered and how the prize pool is split. New formats are added by
// writing a new strategy and registering it in STRATEGIES.
//
// Money: buy-ins go into the ledger account tournament:<id>. At the end the fee (rake) goes to
// house:rake, a guaranteed pool is topped up from house:overlay, and prizes are paid to players.

import type { Db, Row } from './db.ts';
import type { Ledger } from './ledger.ts';
import type { Audit } from './audit.ts';
import type { Events } from './events.ts';
import type { Game, PlayerRow } from './game.ts';
import { MARKETS, payoutFor, priceX100 } from './markets.ts';
import { fail, int, newId, optStr, str } from './util.ts';

export type Entry = { player_id: string; display_name: string; points: number; bets_used: number; joined_at: number };

export interface TournamentStrategy<R = any> {
  id: string;
  name: string;
  parseRules(input: any): R; // validate + fill defaults; throws AppError on bad input
  describe(rules: R): string[]; // plain-language rules for the player screen
  startingPoints(rules: R): number;
  checkBet(rules: R, entry: Entry, stake: number): void; // throw to refuse
  qualifies(rules: R, entry: Entry): boolean; // can this entry win a prize?
  compare(a: Entry, b: Entry): number; // leaderboard order, best first
  prizeSplit(rules: R, paidEntrants: number, pool: number): number[]; // amounts for rank 1..n, sum <= pool
}

// ---------- strategy: points race ----------
// Everyone starts with the same points and may place up to maxBets bets while the tournament
// runs. Highest points at the end wins; the top paidPercent of the field share the pool.

type PointsRaceRules = {
  startingPoints: number;
  maxBets: number;
  minStake: number;
  maxStake: number;
  minBetsToQualify: number;
  paidPercent: number; // e.g. 5 = top 5% are paid
  payoutCurve: 'top_heavy' | 'flat';
  lateJoin: boolean;
};

export const pointsRace: TournamentStrategy<PointsRaceRules> = {
  id: 'points_race',
  name: 'Points race',
  parseRules(input: any = {}) {
    const startingPoints = int(input.startingPoints ?? 1000, 'rules.startingPoints', 10, 1_000_000_000);
    const rules: PointsRaceRules = {
      startingPoints,
      maxBets: int(input.maxBets ?? 100, 'rules.maxBets', 1, 100_000),
      minStake: int(input.minStake ?? 10, 'rules.minStake', 1, startingPoints),
      maxStake: int(input.maxStake ?? startingPoints, 'rules.maxStake', 1, 1_000_000_000),
      minBetsToQualify: int(input.minBetsToQualify ?? 1, 'rules.minBetsToQualify', 0, 100_000),
      paidPercent: typeof input.paidPercent === 'number' && input.paidPercent > 0 && input.paidPercent <= 100 ? input.paidPercent : input.paidPercent === undefined ? 5 : fail(400, 'BAD_INPUT', 'rules.paidPercent must be between 0 and 100'),
      payoutCurve: input.payoutCurve === 'flat' ? 'flat' : 'top_heavy',
      lateJoin: input.lateJoin !== false,
    };
    if (rules.minStake > rules.maxStake) fail(400, 'BAD_INPUT', 'rules.minStake cannot exceed rules.maxStake');
    if (rules.minBetsToQualify > rules.maxBets) fail(400, 'BAD_INPUT', 'rules.minBetsToQualify cannot exceed rules.maxBets');
    return rules;
  },
  describe: (r) => [
    `Everyone starts with ${r.startingPoints} points.`,
    `Up to ${r.maxBets} bets per player, ${r.minStake}–${r.maxStake} points each, on any live table.`,
    r.minBetsToQualify > 0 ? `Place at least ${r.minBetsToQualify} bet${r.minBetsToQualify > 1 ? 's' : ''} to qualify for a prize.` : 'Everyone who joins can win a prize.',
    `The top ${r.paidPercent}% of players share the prize pool${r.payoutCurve === 'flat' ? ' equally' : ', more for higher places'}.`,
    'Ties: fewer bets used ranks higher, then whoever joined first.',
    r.lateJoin ? 'You can join until the tournament ends.' : 'Joining closes when the tournament starts.',
  ],
  startingPoints: (r) => r.startingPoints,
  checkBet(r, e, stake) {
    if (e.bets_used >= r.maxBets) fail(409, 'NO_BETS_LEFT', `You have used all ${r.maxBets} bets`);
    if (stake < r.minStake || stake > r.maxStake) fail(400, 'STAKE_OUT_OF_RANGE', `Stake must be between ${r.minStake} and ${r.maxStake} points`);
  },
  qualifies: (r, e) => e.bets_used >= r.minBetsToQualify,
  compare: (a, b) => b.points - a.points || a.bets_used - b.bets_used || a.joined_at - b.joined_at,
  prizeSplit(r, n, pool) {
    if (n <= 0 || pool <= 0) return [];
    const weights = Array.from({ length: n }, (_, i) => (r.payoutCurve === 'flat' ? 1 : 1 / (i + 1)));
    const total = weights.reduce((s, w) => s + w, 0);
    const out = weights.map((w) => Math.floor((pool * w) / total));
    out[0] += pool - out.reduce((s, x) => s + x, 0); // rounding cents go to first place
    return out;
  },
};

export const STRATEGIES = new Map<string, TournamentStrategy>([[pointsRace.id, pointsRace]]);

// How many places are paid: paidPercent of all entrants, at least one, never more than qualify.
function paidPlaces(rules: any, entrants: number, qualified: number) {
  const pct = typeof rules.paidPercent === 'number' ? rules.paidPercent : 100;
  return Math.min(qualified, Math.max(1, Math.floor((entrants * pct) / 100)));
}

// ---------- engine ----------

export class Tournaments {
  private db: Db;
  private ledger: Ledger;
  private audit: Audit;
  private events: Events;
  private game: Game;
  private now: () => number;

  constructor(db: Db, ledger: Ledger, audit: Audit, events: Events, game: Game, now: () => number) {
    this.db = db;
    this.ledger = ledger;
    this.audit = audit;
    this.events = events;
    this.game = game;
    this.now = now;
    game.roundHooks.push((round, flopIdx, at) => this.settleRound(round, flopIdx, at));
    game.seatHooks.push((round, playerId, at) => this.cancelPlayerBets(round, playerId, at));
  }

  create(input: Row, actor: string) {
    const strategy = STRATEGIES.get(String(input.strategy ?? 'points_race')) ?? fail(400, 'UNKNOWN_STRATEGY', `Known strategies: ${[...STRATEGIES.keys()].join(', ')}`);
    const rules = strategy.parseRules(input.rules ?? {});
    const startsAt = int(input.startsAt ?? this.now(), 'startsAt');
    const endsAt = int(input.endsAt ?? startsAt + 8 * 3600_000, 'endsAt');
    if (endsAt <= startsAt) fail(400, 'BAD_INPUT', 'endsAt must be after startsAt');
    const id = newId('trn');
    const t = {
      name: str(input.name, 'name', 80),
      currency: str(input.currency ?? 'EUR', 'currency', 3, 3).toUpperCase(),
      buyIn: int(input.buyIn ?? 0, 'buyIn'),
      rakeBps: int(input.rakeBps ?? 1000, 'rakeBps', 0, 5000),
      guaranteed: int(input.guaranteed ?? 0, 'guaranteed'),
    };
    this.db.run(
      `INSERT INTO tournaments (id, name, strategy, rules, status, currency, buy_in, rake_bps, guaranteed, starts_at, ends_at, created_by, created_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, t.name, strategy.id, JSON.stringify(rules), t.currency, t.buyIn, t.rakeBps, t.guaranteed, startsAt, endsAt, actor, this.now(),
    );
    this.audit.log(actor, 'tournament.create', { tournamentId: id, strategy: strategy.id, rules, ...t, startsAt, endsAt });
    this.tick();
    this.events.publish('lobby', 'tournaments.changed', {});
    return this.view(id);
  }

  get(id: string): Row {
    return this.db.get('SELECT * FROM tournaments WHERE id = ?', id) ?? fail(404, 'TOURNAMENT_NOT_FOUND');
  }

  list(includeFinished = false) {
    const rows = this.db.all(
      `SELECT * FROM tournaments ${includeFinished ? '' : "WHERE status IN ('scheduled','running','finishing')"} ORDER BY starts_at DESC LIMIT 100`,
    );
    return rows.map((t) => this.summary(t));
  }

  private summary(t: Row) {
    const strategy = STRATEGIES.get(t.strategy)!;
    const rules = JSON.parse(t.rules);
    const entrants = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?', t.id)!.n;
    return {
      id: t.id, name: t.name, strategy: t.strategy, strategyName: strategy.name, status: t.status, currency: t.currency,
      buyIn: t.buy_in, rakeBps: t.rake_bps, guaranteed: t.guaranteed, startsAt: t.starts_at, endsAt: t.ends_at,
      entrants, prizePool: t.prize_pool ?? this.projectedPool(t, entrants), paidPlaces: paidPlaces(rules, entrants, entrants),
      rules, howItWorks: strategy.describe(rules),
    };
  }

  private projectedPool(t: Row, entrants: number) {
    const buyIns = t.buy_in * entrants;
    return Math.max(buyIns - Math.floor((buyIns * t.rake_bps) / 10_000), t.guaranteed);
  }

  view(id: string, playerId?: string) {
    const t = this.get(id);
    const out: any = { ...this.summary(t), leaderboard: this.leaderboard(id, 100) };
    if (playerId) {
      const e = this.entry(id, playerId);
      out.me = e ? { ...this.position(id, playerId), bets: this.playerBets(id, playerId) } : null;
    }
    return out;
  }

  entry(tournamentId: string, playerId: string): Entry | undefined {
    return this.db.get<Entry>(
      'SELECT e.*, p.display_name FROM tournament_entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ? AND e.player_id = ?',
      tournamentId, playerId,
    );
  }

  private ranked(tournamentId: string) {
    const t = this.get(tournamentId);
    const strategy = STRATEGIES.get(t.strategy)!;
    const rules = JSON.parse(t.rules);
    const entries = this.db.all<Entry & { rank: number | null; prize: number }>(
      'SELECT e.*, p.display_name FROM tournament_entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ?',
      tournamentId,
    );
    if (t.status === 'finished') return entries.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((e) => ({ e, prize: e.prize, qualified: e.rank !== null }));
    const qualified = entries.filter((e) => strategy.qualifies(rules, e)).sort(strategy.compare);
    const rest = entries.filter((e) => !strategy.qualifies(rules, e)).sort(strategy.compare);
    const pool = this.projectedPool(t, entries.length);
    const split = strategy.prizeSplit(rules, paidPlaces(rules, entries.length, qualified.length), pool);
    return [...qualified.map((e, i) => ({ e, prize: split[i] ?? 0, qualified: true })), ...rest.map((e) => ({ e, prize: 0, qualified: false }))];
  }

  leaderboard(tournamentId: string, limit = 100) {
    return this.ranked(tournamentId).slice(0, limit).map(({ e, prize, qualified }, i) => ({
      rank: i + 1, playerId: e.player_id, displayName: e.display_name, points: e.points, betsUsed: e.bets_used, qualified, prize,
    }));
  }

  private position(tournamentId: string, playerId: string) {
    const all = this.ranked(tournamentId);
    const i = all.findIndex((x) => x.e.player_id === playerId);
    const { e, prize, qualified } = all[i];
    return { rank: i + 1, of: all.length, points: e.points, betsUsed: e.bets_used, qualified, prize };
  }

  playerBets(tournamentId: string, playerId: string) {
    return this.db.all(
      `SELECT tb.*, r.number AS round_number, r.flop, t.name AS table_name FROM tournament_bets tb
       JOIN rounds r ON r.id = tb.round_id JOIN tables t ON t.id = r.table_id
       WHERE tb.tournament_id = ? AND tb.player_id = ? ORDER BY tb.placed_at DESC LIMIT 200`,
      tournamentId, playerId,
    ).map((b) => ({
      id: b.id, roundId: b.round_id, roundNumber: b.round_number, tableName: b.table_name, marketId: b.market_id, stake: b.stake,
      oddsX100: b.odds_x100, status: b.status, payout: b.payout, placedAt: b.placed_at, flop: b.flop ? JSON.parse(b.flop) : null,
    }));
  }

  join(tournamentId: string, player: PlayerRow) {
    const t = this.get(tournamentId);
    const rules = JSON.parse(t.rules);
    const strategy = STRATEGIES.get(t.strategy)!;
    this.assertCanPlay(player);
    if (this.entry(tournamentId, player.id)) fail(409, 'ALREADY_JOINED');
    const canJoin = t.status === 'scheduled' || (t.status === 'running' && rules.lateJoin !== false && this.now() < t.ends_at);
    if (!canJoin) fail(409, 'REGISTRATION_CLOSED');
    const op = this.db.get('SELECT * FROM operators WHERE id = ?', player.operator_id)!;
    this.db.tx(() => {
      if (t.buy_in > 0) {
        if (op.wallet_mode !== 'transfer') fail(409, 'BUY_IN_UNAVAILABLE', 'Paid tournaments are not available through your provider yet');
        if (op.currency !== t.currency) fail(409, 'CURRENCY_MISMATCH', `This tournament is played in ${t.currency}`);
        this.ledger.transfer('tournament.buy_in', `${tournamentId}:${player.id}`, t.currency, `player:${player.id}`, `tournament:${tournamentId}`, t.buy_in);
      }
      this.db.run('INSERT INTO tournament_entries (tournament_id, player_id, points, joined_at) VALUES (?, ?, ?, ?)', tournamentId, player.id, strategy.startingPoints(rules), this.now());
    });
    this.publish(tournamentId);
    return this.view(tournamentId, player.id);
  }

  placeBet(tournamentId: string, player: PlayerRow, input: Row) {
    const t = this.get(tournamentId);
    const strategy = STRATEGIES.get(t.strategy)!;
    const rules = JSON.parse(t.rules);
    const clientRef = optStr(input.clientRef, 'clientRef', 64);
    if (clientRef) {
      const prior = this.db.get('SELECT id FROM tournament_bets WHERE tournament_id = ? AND player_id = ? AND client_ref = ?', tournamentId, player.id, clientRef);
      if (prior) return this.view(tournamentId, player.id);
    }
    if (t.status !== 'running' || this.now() >= t.ends_at) fail(409, 'TOURNAMENT_NOT_RUNNING');
    this.assertCanPlay(player);
    const entry = this.entry(tournamentId, player.id) ?? fail(409, 'NOT_JOINED');
    const round = this.game.round(str(input.roundId, 'roundId', 64));
    if (round.status !== 'open' || this.now() >= round.closes_at) fail(409, 'BETTING_CLOSED');
    this.game.assertNotSeated(round.table_id, player.id);
    const table = this.game.table(round.table_id);
    if (table.status !== 'active') fail(409, 'TABLE_INACTIVE');
    const market = MARKETS.get(str(input.marketId, 'marketId', 40)) ?? fail(400, 'UNKNOWN_MARKET');
    const odds = priceX100(market, table.margin_bps) ?? fail(400, 'MARKET_NOT_OFFERED');
    const stake = int(input.stake, 'stake', 1);
    strategy.checkBet(rules, entry!, stake);
    if (stake > entry!.points) fail(402, 'NOT_ENOUGH_POINTS');
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO tournament_bets (id, tournament_id, player_id, round_id, market_id, stake, odds_x100, status, placed_at, client_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        newId('tb'), tournamentId, player.id, round.id, market.id, stake, odds, this.now(), clientRef,
      );
      this.db.run('UPDATE tournament_entries SET points = points - ?, bets_used = bets_used + 1 WHERE tournament_id = ? AND player_id = ?', stake, tournamentId, player.id);
    });
    this.publish(tournamentId);
    return this.view(tournamentId, player.id);
  }

  // Runs inside the game's settlement transaction for every settled or voided round.
  private settleRound(round: Row, flopIdx: number | null, now: number) {
    const bets = this.db.all("SELECT * FROM tournament_bets WHERE round_id = ? AND status = 'open'", round.id);
    const touched = new Set<string>();
    for (const b of bets) {
      touched.add(b.tournament_id);
      if (flopIdx === null) {
        // Void: points back, and the bet does not count against the bet limit.
        this.db.run("UPDATE tournament_bets SET status = 'refunded', payout = stake, settled_at = ? WHERE id = ?", now, b.id);
        this.db.run('UPDATE tournament_entries SET points = points + ?, bets_used = bets_used - 1 WHERE tournament_id = ? AND player_id = ?', b.stake, b.tournament_id, b.player_id);
        continue;
      }
      const won = MARKETS.get(b.market_id)!.wins[flopIdx] === 1;
      const payout = won ? payoutFor(b.stake, b.odds_x100) : 0;
      this.db.run('UPDATE tournament_bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?', won ? 'won' : 'lost', payout, now, b.id);
      if (payout) this.db.run('UPDATE tournament_entries SET points = points + ? WHERE tournament_id = ? AND player_id = ?', payout, b.tournament_id, b.player_id);
    }
    queueMicrotask(() => touched.forEach((id) => this.publish(id)));
  }

  // Same eligibility as cash betting: a blocked player or a suspended partner's player cannot play.
  private assertCanPlay(player: PlayerRow) {
    const op = this.db.get<{ status: string }>('SELECT status FROM operators WHERE id = ?', player.operator_id);
    if (op?.status !== 'active') fail(403, 'OPERATOR_SUSPENDED');
    const fresh = this.db.get<{ status: string }>('SELECT status FROM players WHERE id = ?', player.id);
    if (fresh?.status !== 'active') fail(403, 'PLAYER_BLOCKED');
  }

  // A player who sits down at the table gets this hand's tournament bets back (points and bet count).
  private cancelPlayerBets(round: Row, playerId: string, now: number) {
    const bets = this.db.all("SELECT * FROM tournament_bets WHERE round_id = ? AND player_id = ? AND status = 'open'", round.id, playerId);
    for (const b of bets) {
      this.db.run("UPDATE tournament_bets SET status = 'refunded', payout = stake, settled_at = ? WHERE id = ?", now, b.id);
      this.db.run('UPDATE tournament_entries SET points = points + ?, bets_used = bets_used - 1 WHERE tournament_id = ? AND player_id = ?', b.stake, b.tournament_id, playerId);
    }
    const touched = new Set(bets.map((b) => b.tournament_id));
    queueMicrotask(() => touched.forEach((id) => this.publish(id)));
    return bets.length;
  }

  // Moves tournaments through their life cycle. Called by the background timer.
  tick() {
    const now = this.now();
    for (const t of this.db.all("SELECT id FROM tournaments WHERE status = 'scheduled' AND starts_at <= ?", now)) {
      this.db.run("UPDATE tournaments SET status = 'running' WHERE id = ?", t.id);
      this.audit.log('system', 'tournament.start', { tournamentId: t.id });
      this.publish(t.id);
    }
    for (const t of this.db.all("SELECT id FROM tournaments WHERE status = 'running' AND ends_at <= ?", now)) {
      this.db.run("UPDATE tournaments SET status = 'finishing' WHERE id = ?", t.id);
      this.publish(t.id);
    }
    // Bets placed before the end still count; wait until their rounds are settled.
    for (const t of this.db.all("SELECT id FROM tournaments WHERE status = 'finishing'")) {
      if (!this.db.get("SELECT 1 FROM tournament_bets WHERE tournament_id = ? AND status = 'open'", t.id)) this.finish(t.id);
    }
  }

  private finish(id: string) {
    const t = this.get(id);
    const strategy = STRATEGIES.get(t.strategy)!;
    const rules = JSON.parse(t.rules);
    this.db.tx(() => {
      const entries = this.db.all<Entry>('SELECT e.*, p.display_name FROM tournament_entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ?', id);
      const qualified = entries.filter((e) => strategy.qualifies(rules, e)).sort(strategy.compare);
      const pot = `tournament:${id}`;
      const buyIns = this.ledger.balance(pot, t.currency);
      if (qualified.length === 0) {
        for (const e of entries) if (t.buy_in > 0) this.ledger.transfer('tournament.refund', `${id}:${e.player_id}`, t.currency, pot, `player:${e.player_id}`, t.buy_in);
        this.db.run("UPDATE tournaments SET status = 'finished', prize_pool = 0 WHERE id = ?", id);
        this.audit.log('system', 'tournament.finish', { tournamentId: id, entrants: entries.length, paid: 0, note: 'nobody qualified, buy-ins refunded' });
        return;
      }
      const rake = Math.floor((buyIns * t.rake_bps) / 10_000);
      if (rake) this.ledger.transfer('tournament.rake', id, t.currency, pot, 'house:rake', rake);
      const overlay = Math.max(0, t.guaranteed - (buyIns - rake));
      if (overlay) this.ledger.transfer('tournament.overlay', id, t.currency, 'house:overlay', pot, overlay);
      const pool = buyIns - rake + overlay;
      const split = strategy.prizeSplit(rules, paidPlaces(rules, entries.length, qualified.length), pool);
      qualified.forEach((e, i) => {
        const prize = split[i] ?? 0;
        this.db.run('UPDATE tournament_entries SET rank = ?, prize = ? WHERE tournament_id = ? AND player_id = ?', i + 1, prize, id, e.player_id);
        if (prize) this.ledger.transfer('tournament.prize', `${id}:${e.player_id}`, t.currency, pot, `player:${e.player_id}`, prize);
      });
      this.db.run("UPDATE tournaments SET status = 'finished', prize_pool = ? WHERE id = ?", pool, id);
      this.audit.log('system', 'tournament.finish', { tournamentId: id, entrants: entries.length, pool, rake, overlay, paid: split.length, prizes: split });
    });
    this.publish(id);
  }

  cancel(id: string, reason: unknown, actor: string) {
    const t = this.get(id);
    if (t.status === 'finished' || t.status === 'cancelled') fail(409, 'TOURNAMENT_FINISHED');
    const why = str(reason, 'reason', 300);
    this.db.tx(() => {
      const entries = this.db.all('SELECT player_id FROM tournament_entries WHERE tournament_id = ?', id);
      for (const e of entries) if (t.buy_in > 0) this.ledger.transfer('tournament.refund', `${id}:${e.player_id}`, t.currency, `tournament:${id}`, `player:${e.player_id}`, t.buy_in);
      this.db.run("UPDATE tournament_bets SET status = 'refunded', payout = stake, settled_at = ? WHERE tournament_id = ? AND status = 'open'", this.now(), id);
      this.db.run("UPDATE tournaments SET status = 'cancelled' WHERE id = ?", id);
      this.audit.log(actor, 'tournament.cancel', { tournamentId: id, reason: why, refunded: entries.length });
    });
    this.publish(id);
    return this.summary(this.get(id));
  }

  private publish(id: string) {
    this.events.publish(`tournament:${id}`, 'tournament.changed', { id });
    this.events.publish('lobby', 'tournaments.changed', {});
  }
}
