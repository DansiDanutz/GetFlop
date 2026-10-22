// Tables for the tournaments module.
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { clubs, clubTables, users } from './core.js';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/** Integer cents of a Point, or of a tournament chip (TC). */
const cents = (name: string) => bigint(name, { mode: 'number' });

export type TournamentStatus = 'upcoming' | 'active' | 'finished' | 'cancelled';

export interface TournamentLevelJson {
  levelNumber: number;
  /** Minimum per pick, in chip cents (100 = 1 TC). */
  minBetChips: number;
  /** −1 = no maximum. */
  maxBetChips: number;
  endHand: number;
}

export const tournaments = pgTable('tournaments', {
  id: id(),
  clubId: text('club_id').notNull().references(() => clubs.id),
  tableId: text('table_id').notNull().references(() => clubTables.id),
  name: text('name').notNull(),
  status: text('status').$type<TournamentStatus>().notNull().default('upcoming'),
  /** Human dealer, or null when auto-dealt. */
  dealerId: text('dealer_id').references(() => users.id),
  /** Auto-deal interval (5–120 s), or null with a human dealer. */
  autoDealSeconds: integer('auto_deal_seconds'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  autoStart: boolean('auto_start').notNull().default(false),
  pinned: boolean('pinned').notNull().default(false),
  botsAllowed: boolean('bots_allowed').notNull().default(false),
  buyInCents: cents('buy_in_cents').notNull(),
  feeCents: cents('fee_cents').notNull(),
  startingStack: cents('starting_stack').notNull(),
  allowRebuys: boolean('allow_rebuys').notNull().default(false),
  maxRebuys: integer('max_rebuys').notNull().default(-1),
  rebuyStack: cents('rebuy_stack').notNull(),
  rebuyCostCents: cents('rebuy_cost_cents').notNull(),
  rebuyFeeCents: cents('rebuy_fee_cents').notNull().default(0),
  rebuyEndHand: integer('rebuy_end_hand').notNull(),
  allowAddons: boolean('allow_addons').notNull().default(false),
  addonCostCents: cents('addon_cost_cents').notNull(),
  addonStack: cents('addon_stack').notNull(),
  addonEndHand: integer('addon_end_hand').notNull(),
  minActionPct: integer('min_action_pct').notNull().default(50),
  allowLateRegistration: boolean('allow_late_registration').notNull().default(true),
  lateRegEndHand: integer('late_reg_end_hand').notNull(),
  /** Allowed markets (slugs). */
  markets: text('markets').array().notNull().default(sql`'{}'::text[]`),
  levels: jsonb('levels').$type<TournamentLevelJson[]>().notNull(),
  /** guaranteed | progressive */
  prizePoolType: text('prize_pool_type').notNull().default('progressive'),
  guaranteedPrizeCents: cents('guaranteed_prize_cents').notNull().default(0),
  /** Percentages, biggest first, summing to 100. */
  payoutStructure: jsonb('payout_structure').$type<number[]>().notNull(),
  /** hands | manual */
  endCondition: text('end_condition').notNull().default('hands'),
  endValue: integer('end_value').notNull(),
  /** Settled tournament hands so far. */
  handsPlayed: integer('hands_played').notNull().default(0),
  currentLevel: integer('current_level').notNull().default(1),
  /** Final pool paid out (set at finish). */
  finalPoolCents: cents('final_pool_cents'),
  createdBy: text('created_by').references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('tournaments_club_status_idx').on(t.clubId, t.status),
  index('tournaments_table_idx').on(t.tableId),
]);

/** registered = entered, waiting for the start; active = playing; busted = 0 chips; eliminated = participation; unregistered = refunded. */
export type EntryStatus = 'registered' | 'active' | 'busted' | 'eliminated' | 'unregistered';

/** One player's entry: their chip stack lives here (the `chips` funds unit). */
export const tournamentEntries = pgTable('tournament_entries', {
  id: id(),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id),
  clubId: text('club_id').notNull().references(() => clubs.id),
  userId: text('user_id').notNull().references(() => users.id),
  status: text('status').$type<EntryStatus>().notNull().default('registered'),
  isBot: boolean('is_bot').notNull().default(false),
  /** Chips free to commit. */
  chips: cents('chips').notNull().default(0),
  /** Chips committed to live coupons, not yet settled. */
  chipsInPlay: cents('chips_in_play').notNull().default(0),
  rebuys: integer('rebuys').notNull().default(0),
  addons: integer('addons').notNull().default(0),
  /** Points paid into the prize pool (buy-in, rebuys, add-ons). */
  paidCents: cents('paid_cents').notNull().default(0),
  /** Points paid as fees to the club. */
  feesCents: cents('fees_cents').notNull().default(0),
  /** Hands with action ("done"). */
  handsActed: integer('hands_acted').notNull().default(0),
  /** Hands dealt while entered. */
  handsDealt: integer('hands_dealt').notNull().default(0),
  registeredAtHand: integer('registered_at_hand').notNull().default(0),
  outAtHand: integer('out_at_hand'),
  /** chips | participation */
  eliminatedReason: text('eliminated_reason'),
  finishPosition: integer('finish_position'),
  prizeCents: cents('prize_cents').notNull().default(0),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('tournament_entries_uq').on(t.tournamentId, t.userId),
  index('tournament_entries_user_idx').on(t.userId),
]);

/** Event log shown to staff (bot telemetry, lifecycle). Append-only. */
export const tournamentEvents = pgTable('tournament_events', {
  id: id(),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id),
  /** info | warning | error */
  severity: text('severity').notNull().default('info'),
  kind: text('kind').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('tournament_events_idx').on(t.tournamentId, t.createdAt)]);
