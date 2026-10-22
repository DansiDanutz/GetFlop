/**
 * Pure tournament rules: wizard defaults and validation, levels, participation (VPIP),
 * standings order and prize arithmetic. No I/O — everything here is unit-tested directly.
 *
 * Units: Points and chips are integer cents (100 = 1 PTS / 1 TC).
 */
import { AppError } from '../../http/errors.js';
import type { TournamentLevelJson } from '../../db/schema/tournaments.js';

/** Commitment cap: a coupon may commit at most this share of the free stack (coupon.over_exposure). */
export const EXPOSURE_CAP_PCT = 50;
/** Unregistering from an auto-start tournament closes this long before the start. */
export const UNREGISTER_CUTOFF_MINUTES = 1;
/** Manual end: the tournament runs "forever" until staff finish it. */
export const MANUAL_END_VALUE = 9999;
export const AUTO_DEAL_MIN_SECONDS = 5;
export const AUTO_DEAL_MAX_SECONDS = 120;
export const AUTO_DEAL_DEFAULT_SECONDS = 20;
const NAME_MAX = 60;
const PCT_TOLERANCE = 1e-6;

export const MARKET_PRESETS = {
  grindy: ['rainbow', 'same-color', 'has-ace'],
  mixed: ['rainbow', 'same-color', 'has-ace', 'any-pair', 'any-flush'],
  /** Empty = every active market. */
  lottery: [] as string[],
} as const;

export const DEFAULT_LEVELS: readonly TournamentLevelJson[] = [
  { levelNumber: 1, minBetChips: 10_000, maxBetChips: -1, endHand: 10 },
  { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, endHand: 20 },
  { levelNumber: 3, minBetChips: 50_000, maxBetChips: -1, endHand: 30 },
  { levelNumber: 4, minBetChips: 100_000, maxBetChips: -1, endHand: 40 },
  { levelNumber: 5, minBetChips: 200_000, maxBetChips: -1, endHand: 50 },
];

export const DEFAULTS = {
  buyInCents: 500,
  feeCents: 50,
  startingStack: 1_000_000,
  maxRebuys: -1,
  rebuyStack: 1_000_000,
  rebuyCostCents: 500,
  rebuyFeeCents: 0,
  rebuyEndHand: 30,
  addonCostCents: 500,
  addonStack: 1_500_000,
  minActionPct: 50,
  lateRegEndHand: 10,
  guaranteedPrizeCents: 5_000,
  payoutStructure: [50, 30, 20],
  endValue: 50,
} as const;

export interface TournamentInput {
  readonly name?: string;
  readonly dealerId?: string | null;
  readonly autoDealSeconds?: number | null;
  readonly scheduledAt?: string | null;
  readonly autoStart?: boolean;
  readonly pinned?: boolean;
  readonly botsAllowed?: boolean;
  readonly buyInCents?: number;
  readonly feeCents?: number;
  readonly startingStack?: number;
  readonly allowRebuys?: boolean;
  readonly maxRebuys?: number;
  readonly rebuyStack?: number;
  readonly rebuyCostCents?: number;
  readonly rebuyFeeCents?: number;
  readonly rebuyEndHand?: number;
  readonly allowAddons?: boolean;
  readonly addonCostCents?: number;
  readonly addonStack?: number;
  readonly addonEndHand?: number;
  readonly minActionPct?: number;
  readonly allowLateRegistration?: boolean;
  readonly lateRegEndHand?: number;
  readonly allowedBetTypeIds?: readonly string[];
  readonly levels?: readonly Partial<TournamentLevelJson>[];
  readonly prizePoolType?: 'guaranteed' | 'progressive';
  readonly guaranteedPrizeCents?: number;
  readonly payoutStructure?: readonly unknown[] | string;
  readonly endCondition?: 'hands' | 'manual';
  readonly endValue?: number;
}

export interface TournamentConfig {
  readonly name: string;
  readonly dealerId: string | null;
  readonly autoDealSeconds: number | null;
  readonly scheduledAt: Date | null;
  readonly autoStart: boolean;
  readonly pinned: boolean;
  readonly botsAllowed: boolean;
  readonly buyInCents: number;
  readonly feeCents: number;
  readonly startingStack: number;
  readonly allowRebuys: boolean;
  readonly maxRebuys: number;
  readonly rebuyStack: number;
  readonly rebuyCostCents: number;
  readonly rebuyFeeCents: number;
  readonly rebuyEndHand: number;
  readonly allowAddons: boolean;
  readonly addonCostCents: number;
  readonly addonStack: number;
  readonly addonEndHand: number;
  readonly minActionPct: number;
  readonly allowLateRegistration: boolean;
  readonly lateRegEndHand: number;
  readonly markets: readonly string[];
  readonly levels: readonly TournamentLevelJson[];
  readonly prizePoolType: 'guaranteed' | 'progressive';
  readonly guaranteedPrizeCents: number;
  readonly payoutStructure: readonly number[];
  readonly endCondition: 'hands' | 'manual';
  readonly endValue: number;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
// eslint-disable-next-line no-control-regex
const DAMAGED = /[�<>"'`\\\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Hands with action a player needs: ceil(p × T / 100) (inferred rounding). */
export function requiredHands(minActionPct: number, totalHands: number): number {
  return Math.ceil((minActionPct * totalHands) / 100);
}

/** Last hand late registration may stay open and still let a newcomer meet participation. */
export function lastLateRegHand(minActionPct: number, totalHands: number): number {
  return totalHands - requiredHands(minActionPct, totalHands) + 1;
}

function validateName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) throw new AppError('trm.create_missing');
  if (name.length > NAME_MAX || DAMAGED.test(name)) throw new AppError('trm.name_damaged');
  return name;
}

export function validateLevels(raw: readonly Partial<TournamentLevelJson>[]): TournamentLevelJson[] {
  if (raw.length === 0) throw new AppError('trm.levels_required');
  const out: TournamentLevelJson[] = [];
  raw.forEach((l, i) => {
    const level = i + 1;
    if (l.levelNumber !== level) throw new AppError('trm.levels_order', 400, { level });
    if (!isInt(l.endHand) || l.endHand < 1) throw new AppError('trm.level_end_invalid', 400, { level });
    const prev = out[i - 1];
    if (prev && l.endHand <= prev.endHand) throw new AppError('trm.level_end_order', 400, { level, end: l.endHand, prev: prev.endHand });
    if (!isInt(l.minBetChips) || l.minBetChips <= 0) throw new AppError('trm.level_min_invalid', 400, { level });
    const max = l.maxBetChips ?? -1;
    if (!isInt(max) || (max !== -1 && max < l.minBetChips)) {
      throw new AppError('trm.level_max_below', 400, { level, max, min: l.minBetChips });
    }
    out.push({ levelNumber: level, minBetChips: l.minBetChips, maxBetChips: max, endHand: l.endHand });
  });
  return out;
}

/** Accepts [50, 30, 20] or "50, 30, 20". */
export function parsePayouts(raw: readonly unknown[] | string | undefined): number[] {
  if (raw === undefined) return [...DEFAULTS.payoutStructure];
  const parts = typeof raw === 'string' ? raw.split(/[,\s]+/).filter(Boolean) : [...raw];
  if (parts.length === 0) throw new AppError('trm.payouts_empty');
  const values = parts.map((p) => (typeof p === 'string' && /^\d+(\.\d{1,2})?$/.test(p.trim()) ? Number(p) : p));
  if (!values.every((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    throw new AppError('trm.payouts_not_numbers');
  }
  const sum = values.reduce((s, v) => s + v, 0);
  if (Math.abs(sum - 100) > PCT_TOLERANCE) throw new AppError('trm.payouts_sum', 400, { n: Math.round(sum * 100) / 100 });
  return values;
}

function parseSchedule(input: TournamentInput): Date | null {
  if (input.scheduledAt === undefined || input.scheduledAt === null || input.scheduledAt === '') {
    if (input.autoStart) throw new AppError('trm.autostart_needs_time');
    return null;
  }
  const at = new Date(input.scheduledAt);
  if (Number.isNaN(at.getTime())) throw new AppError('trm.scheduled_invalid');
  return at;
}

function dealing(input: TournamentInput): { dealerId: string | null; autoDealSeconds: number | null } {
  const dealerId = input.dealerId || null;
  const auto = input.autoDealSeconds ?? null;
  if ((dealerId === null) === (auto === null)) throw new AppError('trm.dealer_or_auto');
  if (auto !== null && (!isInt(auto) || auto < AUTO_DEAL_MIN_SECONDS || auto > AUTO_DEAL_MAX_SECONDS)) {
    throw new AppError('trm.dealer_or_auto');
  }
  return { dealerId, autoDealSeconds: auto };
}

function amount(value: number | undefined, fallback: number, min = 0): number {
  const v = value ?? fallback;
  if (!isInt(v) || v < min) throw new AppError('validation.invalid', 400, { field: 'amount', message: String(v) });
  return v;
}

function checkParticipation(cfg: { minActionPct: number; allowLateRegistration: boolean; lateRegEndHand: number; endCondition: string; endValue: number }) {
  const pct = cfg.minActionPct;
  if (!isInt(pct) || pct < 0 || pct > 100) throw new AppError('trm.min_action_invalid');
  if (!cfg.allowLateRegistration || cfg.endCondition !== 'hands') return;
  const total = cfg.endValue;
  const hand = cfg.lateRegEndHand;
  if (!isInt(hand) || hand < 1) throw new AppError('trm.latereg_after_end', 400, { hand, total });
  if (hand > total) throw new AppError('trm.latereg_after_end', 400, { hand, total });
  if (pct === 0) return;
  const last = lastLateRegHand(pct, total);
  if (hand > last) {
    throw new AppError('trm.latereg_too_late', 400, { hand, need: requiredHands(pct, total), total, pct, last });
  }
}

function checkAddon(cfg: { allowAddons: boolean; rebuyEndHand: number; addonEndHand: number; endCondition: string; endValue: number }) {
  if (!cfg.allowAddons) return;
  if (cfg.addonEndHand < cfg.rebuyEndHand) {
    throw new AppError('trm.addon_before_open', 400, { addon: cfg.addonEndHand, rebuy: cfg.rebuyEndHand });
  }
  if (cfg.endCondition === 'hands' && cfg.rebuyEndHand + 1 > cfg.endValue) {
    throw new AppError('trm.addon_after_end', 400, { rebuy: cfg.rebuyEndHand, total: cfg.endValue });
  }
}

/** Applies wizard defaults and every server validation of POST /tournaments (docs/spec/10 §2). */
export function resolveConfig(input: TournamentInput, knownMarkets: ReadonlySet<string>): TournamentConfig {
  if (input.levels === undefined) throw new AppError('trm.create_missing');
  const name = validateName(input.name);
  const levels = validateLevels(input.levels);
  const { dealerId, autoDealSeconds } = dealing(input);
  const scheduledAt = parseSchedule(input);
  const endCondition = input.endCondition ?? 'hands';
  const endValue = endCondition === 'manual' ? MANUAL_END_VALUE : input.endValue ?? DEFAULTS.endValue;
  if (!isInt(endValue) || endValue < 1) throw new AppError('trm.levels_short', 400, { end: levels.at(-1)!.endHand, total: endValue });
  if (endCondition === 'hands' && levels.at(-1)!.endHand < endValue) {
    throw new AppError('trm.levels_short', 400, { end: levels.at(-1)!.endHand, total: endValue });
  }
  const rebuyEndHand = amount(input.rebuyEndHand, DEFAULTS.rebuyEndHand, 1);
  const base = {
    minActionPct: input.minActionPct ?? DEFAULTS.minActionPct,
    allowLateRegistration: input.allowLateRegistration ?? true,
    lateRegEndHand: input.lateRegEndHand ?? DEFAULTS.lateRegEndHand,
    allowAddons: input.allowAddons ?? false,
    rebuyEndHand,
    addonEndHand: input.addonEndHand ?? rebuyEndHand + 1,
    endCondition, endValue,
  };
  checkParticipation(base);
  checkAddon(base);
  const payoutStructure = parsePayouts(input.payoutStructure);
  const markets = [...new Set(input.allowedBetTypeIds ?? MARKET_PRESETS.mixed)];
  if (markets.some((m) => !knownMarkets.has(m))) throw new AppError('table.market_unknown');
  const prizePoolType = input.prizePoolType ?? 'progressive';
  return {
    ...base, name, levels, dealerId, autoDealSeconds, scheduledAt, markets, payoutStructure, prizePoolType,
    autoStart: Boolean(input.autoStart), pinned: Boolean(input.pinned), botsAllowed: Boolean(input.botsAllowed),
    buyInCents: amount(input.buyInCents, DEFAULTS.buyInCents),
    feeCents: amount(input.feeCents, DEFAULTS.feeCents),
    startingStack: amount(input.startingStack, DEFAULTS.startingStack, 1),
    allowRebuys: input.allowRebuys ?? false,
    maxRebuys: amount(input.maxRebuys, DEFAULTS.maxRebuys, -1),
    rebuyStack: amount(input.rebuyStack, DEFAULTS.rebuyStack, 1),
    rebuyCostCents: amount(input.rebuyCostCents, DEFAULTS.rebuyCostCents),
    rebuyFeeCents: amount(input.rebuyFeeCents, DEFAULTS.rebuyFeeCents),
    addonCostCents: amount(input.addonCostCents, DEFAULTS.addonCostCents),
    addonStack: amount(input.addonStack, DEFAULTS.addonStack, 1),
    guaranteedPrizeCents: prizePoolType === 'guaranteed' ? amount(input.guaranteedPrizeCents, DEFAULTS.guaranteedPrizeCents, 1) : 0,
  };
}

// ───────────────────────────── Levels & hands ─────────────────────────────

/** The level in force for a hand number; past the last level the last one stays. */
export function levelForHand(levels: readonly TournamentLevelJson[], hand: number): TournamentLevelJson {
  return levels.find((l) => hand <= l.endHand) ?? levels.at(-1)!;
}

/** Flops a coupon starting at `startHand` may run: never past its level or the tournament end. */
export function drawsLeft(levels: readonly TournamentLevelJson[], totalHands: number, startHand: number): number {
  const level = levels.find((l) => startHand <= l.endHand);
  const levelEnd = level ? level.endHand : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(levelEnd, totalHands) - startHand + 1);
}

/** Exposure cap for a free stack; a single minimum pick is always allowed when the stack covers it. */
export function exposureCap(stack: number, levelMin: number): number {
  return Math.max(Math.floor((stack * EXPOSURE_CAP_PCT) / 100), Math.min(stack, levelMin));
}

// ───────────────────────────── Participation ─────────────────────────────

export type ParticipationStatus = 'off' | 'good' | 'warn' | 'bad' | 'last_chance' | 'out';

export interface Participation {
  readonly pct: number;
  readonly required: number;
  readonly done: number;
  readonly dealt: number;
  readonly remaining: number;
  readonly more: number;
  readonly spare: number;
  readonly vpipPct: number;
  readonly status: ParticipationStatus;
}

const WARN_MARGIN_PCT = 10;
const WARN_SPARE = 3;

export function participation(p: { minActionPct: number; totalHands: number; handsPlayed: number; done: number; dealt: number }): Participation {
  const required = requiredHands(p.minActionPct, p.totalHands);
  const remaining = Math.max(0, p.totalHands - p.handsPlayed);
  const more = Math.max(0, required - p.done);
  const spare = remaining - more;
  const vpipPct = p.dealt > 0 ? Math.round((p.done / p.dealt) * 100) : 100;
  const status = ((): ParticipationStatus => {
    if (p.minActionPct === 0) return 'off';
    if (spare < 0) return 'out';
    if (spare === 0 && more > 0) return 'last_chance';
    if (vpipPct < p.minActionPct) return 'bad';
    if (vpipPct < p.minActionPct + WARN_MARGIN_PCT || (more > 0 && spare <= WARN_SPARE)) return 'warn';
    return 'good';
  })();
  return { pct: p.minActionPct, required, done: p.done, dealt: p.dealt, remaining, more, spare, vpipPct, status };
}

/** Out when even playing every remaining hand cannot reach the requirement. */
export function cannotMeetParticipation(p: { minActionPct: number; totalHands: number; handsPlayed: number; done: number }): boolean {
  if (p.minActionPct === 0) return false;
  return p.done + Math.max(0, p.totalHands - p.handsPlayed) < requiredHands(p.minActionPct, p.totalHands);
}

// ───────────────────────────── Standings & prizes ─────────────────────────────

export interface RankInput {
  readonly id: string;
  readonly status: string;
  /** Total chips (free + in play). */
  readonly chips: number;
  readonly outAtHand: number | null;
}

/**
 * Standings order: players still in by chips; then players out on participation by
 * their finishing stack; then busted players, later bust first. Equal keys tie.
 */
export function rankEntries<T extends RankInput>(entries: readonly T[]): { entry: T; position: number; tieKey: string }[] {
  const category = (e: T) => (e.status === 'eliminated' ? 1 : e.status === 'busted' ? 2 : 0);
  const key = (e: T) => (category(e) === 2 ? e.outAtHand ?? 0 : e.chips);
  const sorted = [...entries].sort((a, b) => category(a) - category(b) || key(b) - key(a));
  let position = 0;
  let lastTie = '';
  return sorted.map((entry, i) => {
    const tieKey = `${category(entry)}:${key(entry)}`;
    if (tieKey !== lastTie) position = i + 1;
    lastTie = tieKey;
    return { entry, position, tieKey };
  });
}

/** Pool actually paid: progressive = collected; guaranteed = max(GTD, collected) (inferred). */
export function prizePoolCents(type: string, guaranteedCents: number, collectedCents: number): number {
  return type === 'guaranteed' ? Math.max(guaranteedCents, collectedCents) : collectedCents;
}

/** Shares per place: floor(pool × pct / 100); the rounding remainder goes to 1st. */
export function placeShares(poolCents: number, pcts: readonly number[]): number[] {
  const shares = pcts.map((p) => Math.floor((poolCents * Math.round(p * 100)) / 10_000));
  const remainder = poolCents - shares.reduce((s, v) => s + v, 0);
  return shares.map((s, i) => (i === 0 ? s + remainder : s));
}

/**
 * Prize per ranked entry. Tied entries split the combined shares of the places they
 * occupy (floor each, remainder to the first of the group). Places with no entrant
 * are unpaid and their share returns to the club.
 */
export function assignPrizes(ranked: readonly { tieKey: string }[], shares: readonly number[]): number[] {
  const prizes = ranked.map(() => 0);
  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (j + 1 < ranked.length && ranked[j + 1]!.tieKey === ranked[i]!.tieKey) j += 1;
    const size = j - i + 1;
    const combined = shares.slice(i, j + 1).reduce((s, v) => s + v, 0);
    const each = Math.floor(combined / size);
    for (let k = i; k <= j; k += 1) prizes[k] = each + (k === i ? combined - each * size : 0);
    i = j + 1;
  }
  return prizes;
}
