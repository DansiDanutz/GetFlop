// Safer play (responsible gambling) for players who signed up on GetFlop directly. Partners
// run these controls for their own players, so none of this applies to partner players.
//
//   Loss limits    per rolling 24 hours and 7 days. Loss = money the player's balance lost to
//                  play in the window (stakes, buy-ins) minus what came back (winnings, refunds,
//                  prizes), read from the ledger. A stake counts as lost until its bet settles.
//   Deposit limit  per rolling 7 days, enforced at the cashier.
//   Break          a time-out (1-30 days) or self-exclusion (6 months and more): no betting,
//                  no tournaments, no deposits until it ends. It cannot be shortened, by the
//                  player or by staff. Withdrawals stay possible.
//
// Tightening a limit applies at once. Raising or removing one waits COOLING_OFF_MS, so a
// decision taken in the heat of a losing session cannot undo itself.

import type { Db } from './db.ts';
import type { Audit } from './audit.ts';
import type { PlayerRow } from './game.ts';
import { fail, int } from './util.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const COOLING_OFF_MS = DAY;
export const BREAK_DAYS = [1, 7, 30, 180, 365, 1825] as const;
const DIRECT = 'op_direct';

const LIMITS = {
  lossDay: { column: 'loss_day', window: DAY, label: '24-hour loss limit' },
  lossWeek: { column: 'loss_week', window: 7 * DAY, label: '7-day loss limit' },
  depositWeek: { column: 'deposit_week', window: 7 * DAY, label: '7-day deposit limit' },
} as const;
type LimitKey = keyof typeof LIMITS;
type Limits = Record<LimitKey, number | null>;
const KEYS = Object.keys(LIMITS) as LimitKey[];

type State = Limits & { pending: Partial<Limits> | null; pendingFrom: number | null; excludedUntil: number | null };

export class SaferPlay {
  private db: Db;
  private audit: Audit;
  private now: () => number;

  constructor(db: Db, audit: Audit, now: () => number) {
    this.db = db;
    this.audit = audit;
    this.now = now;
  }

  // ---------- player settings ----------

  async view(player: PlayerRow) {
    direct(player);
    const s = await this.db.tx(() => this.state(player.id));
    const currency = (await this.db.get<{ currency: string }>('SELECT currency FROM operators WHERE id = ?', DIRECT))!.currency;
    return {
      currency,
      lossDay: s.lossDay, lossWeek: s.lossWeek, depositWeek: s.depositWeek,
      pending: s.pending, pendingFrom: s.pendingFrom,
      excludedUntil: s.excludedUntil && s.excludedUntil > this.now() ? s.excludedUntil : null,
      used: {
        lossDay: await this.loss(player.id, currency, LIMITS.lossDay.window),
        lossWeek: await this.loss(player.id, currency, LIMITS.lossWeek.window),
        depositWeek: await this.deposits(player.id, currency, LIMITS.depositWeek.window),
      },
      breakDays: BREAK_DAYS,
    };
  }

  // input: any of lossDay / lossWeek / depositWeek; a positive amount, or null for no limit.
  async setLimits(player: PlayerRow, input: Record<string, unknown>) {
    direct(player);
    const wanted: Partial<Limits> = {};
    for (const k of KEYS) {
      if (!(k in input)) continue;
      wanted[k] = input[k] === null || input[k] === '' ? null : int(input[k], k, 1, 1_000_000_000);
    }
    if (!Object.keys(wanted).length) fail(400, 'BAD_INPUT', 'Nothing to change');
    await this.db.tx(async () => {
      const s = await this.state(player.id);
      const pending: Partial<Limits> = { ...(s.pending ?? {}) };
      let loosened = false;
      for (const k of Object.keys(wanted) as LimitKey[]) {
        const v = wanted[k]!;
        if (tighter(v, s[k])) { s[k] = v; delete pending[k]; }
        else if (v !== s[k]) { pending[k] = v; loosened = true; }
        else delete pending[k];
      }
      // Any raise (re)starts the wait for everything still pending.
      const waiting = Object.keys(pending).length > 0;
      s.pending = waiting ? pending : null;
      s.pendingFrom = !waiting ? null : loosened ? this.now() + COOLING_OFF_MS : s.pendingFrom;
      await this.save(player.id, s);
      await this.audit.log(`player:${player.id}`, 'player.limits', { requested: wanted, active: pick(s), pending: s.pending, pendingFrom: s.pendingFrom });
    });
    return this.view(player);
  }

  async takeBreak(player: PlayerRow, daysInput: unknown) {
    direct(player);
    const days = int(daysInput, 'days', 1, 1825);
    if (!(BREAK_DAYS as readonly number[]).includes(days)) fail(400, 'BAD_INPUT', `days must be one of ${BREAK_DAYS.join(', ')}`);
    await this.db.tx(async () => {
      const s = await this.state(player.id);
      const until = this.now() + days * DAY;
      s.excludedUntil = Math.max(s.excludedUntil ?? 0, until); // a break can be extended, never shortened
      await this.save(player.id, s);
      await this.audit.log(`player:${player.id}`, days >= 180 ? 'player.self_exclude' : 'player.time_out', { days, until: s.excludedUntil });
    });
    return this.view(player);
  }

  // ---------- checks (run inside the caller's transaction) ----------

  // Before a cash bet or a paid tournament buy-in: `amount` is what the player is about to put at risk.
  async assertCanPlay(player: PlayerRow, amount: number, currency: string) {
    if (player.operator_id !== DIRECT) return;
    const s = await this.state(player.id);
    this.assertNoBreak(s);
    if (amount <= 0) return;
    for (const k of ['lossDay', 'lossWeek'] as const) {
      const limit = s[k];
      if (limit === null) continue;
      const used = await this.loss(player.id, currency, LIMITS[k].window);
      if (used + amount > limit) fail(403, 'LOSS_LIMIT', `This would pass your ${LIMITS[k].label} (${left(limit, used)} left)`);
    }
  }

  // Before a cashier deposit.
  async assertCanDeposit(playerId: string, amount: number, currency: string) {
    const s = await this.state(playerId);
    this.assertNoBreak(s);
    const limit = s.depositWeek;
    if (limit === null) return;
    const used = await this.deposits(playerId, currency, LIMITS.depositWeek.window);
    if (used + amount > limit) fail(403, 'DEPOSIT_LIMIT', `This would pass the player's ${LIMITS.depositWeek.label} (${left(limit, used)} left)`);
  }

  // Tournament bets use points, not money: only a break stops them.
  async assertNotOnBreak(player: PlayerRow) {
    if (player.operator_id !== DIRECT) return;
    this.assertNoBreak(await this.state(player.id));
  }

  // ---------- internals ----------

  private assertNoBreak(s: State) {
    if (s.excludedUntil && s.excludedUntil > this.now())
      fail(403, 'ON_BREAK', `You are taking a break from play until ${new Date(s.excludedUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  }

  // Current settings; raised limits whose waiting time is over are applied here.
  private async state(playerId: string): Promise<State> {
    const row = await this.db.get('SELECT * FROM player_limits WHERE player_id = ?', playerId);
    const s: State = {
      lossDay: row?.loss_day ?? null, lossWeek: row?.loss_week ?? null, depositWeek: row?.deposit_week ?? null,
      pending: row?.pending ? JSON.parse(row.pending) : null, pendingFrom: row?.pending_from ?? null, excludedUntil: row?.excluded_until ?? null,
    };
    if (s.pending && s.pendingFrom !== null && s.pendingFrom <= this.now()) {
      Object.assign(s, s.pending);
      s.pending = null;
      s.pendingFrom = null;
      await this.save(playerId, s);
    }
    return s;
  }

  private async save(playerId: string, s: State) {
    await this.db.run(
      `INSERT INTO player_limits (player_id, loss_day, loss_week, deposit_week, pending, pending_from, excluded_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET loss_day = excluded.loss_day, loss_week = excluded.loss_week, deposit_week = excluded.deposit_week,
         pending = excluded.pending, pending_from = excluded.pending_from, excluded_until = excluded.excluded_until, updated_at = excluded.updated_at`,
      playerId, s.lossDay, s.lossWeek, s.depositWeek, s.pending ? JSON.stringify(s.pending) : null, s.pendingFrom, s.excludedUntil, this.now(),
    );
  }

  // Net money lost to play started in the last `window` ms (0 if the player is ahead): each cash bet
  // placed in the window counts its stake minus what came back (winnings or a refund), open bets
  // their whole stake; each paid tournament joined in the window its buy-in minus any prize or
  // refund. Results are tied to when the money was put at risk, so a late refund or payout for an
  // older bet cannot offset losses made inside the window.
  private async loss(playerId: string, currency: string, window: number) {
    const since = this.now() - window;
    const cash = await this.db.get<{ net: number }>(
      `SELECT COALESCE(SUM(stake - CASE WHEN status IN ('won','refunded') THEN COALESCE(payout, 0) ELSE 0 END), 0) AS net
       FROM bets WHERE player_id = ? AND currency = ? AND placed_at > ? AND status IN ('pending','open','won','lost','refunded')`,
      playerId, currency, since,
    );
    const tours = await this.db.get<{ net: number }>(
      `SELECT COALESCE(SUM(t.buy_in - e.prize - CASE WHEN EXISTS (
           SELECT 1 FROM ledger_tx x WHERE x.kind = 'tournament.refund' AND x.ref = t.id || ':' || e.player_id) THEN t.buy_in ELSE 0 END), 0) AS net
       FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.player_id = ? AND t.currency = ? AND t.buy_in > 0 AND e.joined_at > ?`,
      playerId, currency, since,
    );
    return Math.max(0, Number(cash!.net) + Number(tours!.net));
  }

  private async deposits(playerId: string, currency: string, window: number) {
    const row = await this.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(e.amount), 0) AS total FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account = ? AND e.currency = ? AND t.created_at > ? AND t.kind = 'cashier.deposit'`,
      `player:${playerId}`, currency, this.now() - window,
    );
    return Number(row!.total);
  }
}

function direct(player: PlayerRow) {
  if (player.operator_id !== DIRECT) fail(409, 'NOT_DIRECT_PLAYER', 'Your limits are managed by the site you play through');
}

function tighter(v: number | null, old: number | null) {
  return v !== null && (old === null || v < old);
}

function pick(s: State): Limits {
  return { lossDay: s.lossDay, lossWeek: s.lossWeek, depositWeek: s.depositWeek };
}

function left(limit: number, used: number) {
  return (Math.max(0, limit - used) / 100).toFixed(2);
}
