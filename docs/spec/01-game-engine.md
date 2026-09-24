# 01 · Game Engine

This file covers the deck and flop model, markets and pricing, the hand state machine, coupons, stake limits, settlement, voids, auto-play and the heat board. It is the core of the product: every number here must be implemented exactly.

---

## 1. Cards and flops

- One standard 52-card deck per hand. Ranks `2 3 4 5 6 7 8 9 T J Q K A`, suits `s` (spades), `h` (hearts), `d` (diamonds), `c` (clubs).
- A card is written `<rank><suit>`, for example `Ah`, `Td`, `7c`. The API sends flop cards as `card1`, `card2`, `card3`.
- Colours: hearts and diamonds are red. Spades and clubs are black.
- A flop is 3 **distinct** cards. There are C(52,3) = **22,100** possible flops. Card order does not matter for settlement.
- Validation when entering a flop: exactly 3 cards, each a valid code, no duplicates (see 05-dealer.md).
- Ring Game tables use the physical cards the dealer enters. Arena tables, auto-deal tournaments and simulation tables draw a uniformly random flop from a fresh shuffled deck on every hand (inferred: "every flop is dealt from a fresh shuffle").

---

## 2. Markets

### 2.1 Catalogue

Markets are rows in a platform-wide `bet_types` table:

| Field | Meaning |
|---|---|
| `id` | UUID |
| `slug` | Stable identifier (see below) |
| `name` | Canonical English name (the Greek name comes from a client translation table keyed by slug) |
| `category` | Filter group: `pair`, `flush`, `color`, `straight`, `special` |
| `probability` | Exact chance over 22,100 flops |
| `payout_odds` | Price as X:1. The multiplier shown is `payout_odds + 1` |
| `active` | Whether it is on the board. Off means players cannot pick it |
| retired flag (inferred) | The platform markets report shows "retired" markets |

### 2.2 Market list, win rules and default prices

Exact counts over all 22,100 flops. "Fair ×" = 1/probability. The club margin is `1 − multiplier × probability` (equivalently `1 − (odds + 1) × probability`).

| Slug | Display name | Win rule (on the 3 flop cards) | Winning flops | Probability | Fair × | Default multiplier (odds) | Margin |
|---|---|---|---|---|---|---|---|
| `rainbow` | Rainbow | All three suits are different | 8,788 | 0.397647 | 2.51 | ×2.3 (1.3:1) | 8.5% |
| `same-color` | All Same Color | All red or all black. Two different suits of the same colour still count | 5,200 | 0.235294 | 4.25 | ×3.8 (2.8:1) | 10.6% |
| `has-ace` | Contains an Ace | At least one ace | 4,804 | 0.217376 | 4.60 | ×4 (3:1) | 13.0% |
| `any-pair` | Any Pair | Exactly two cards share a rank. **Trips are not a pair** | 3,744 | 0.169412 | 5.90 | ×5 (4:1) | 15.3% |
| `any-flush` | Flush (Any Suit) | All three the same suit (includes straight flushes) | 1,144 | 0.051765 | 19.32 | ×16 (15:1) | 17.2% |
| `all-lows` | All Low Cards (2-6) | Every card is 2–6 (pairs and trips of low cards count) | 1,140 | 0.051584 | 19.39 | ×16 (15:1) | 17.5% |
| `straight` | Three Consecutive | Three consecutive ranks, any suits, any order. Ace is high **and** low: `A-2-3` and `Q-K-A` count, `K-A-2` does not. Includes straight flushes | 768 | 0.034751 | 28.78 | ×24 (23:1) | 16.6% |
| `all-faces` | Jack or Better | Every card is J, Q, K **or A** | 560 | 0.025339 | 39.46 | ×30 (29:1) | 24.0% |
| `pair-aces` … `pair-twos` (13 markets) | Pair of Aces … Pair of Twos | Exactly two cards of that rank (trips of that rank do **not** win) | 288 each | 0.013032 | 76.74 | ×60 (59:1) | 21.8% |
| `flush-hearts`, `flush-diamonds`, `flush-clubs`, `flush-spades` | All Hearts / Diamonds / Clubs / Spades | All three cards are exactly that suit | 286 each | 0.012941 | 77.27 | ×60 (59:1) | 22.4% |
| `trips-or-sf` | Trips or Straight Flush | Three of a kind **or** a straight flush (one market, one multiplier) | 100 | 0.004525 | 221.0 | ×170 (169:1) | 23.1% |
| `any-trips` | Trips | All three the same rank | 52 | 0.002353 | 425.0 | not published (inferred retired) | — |
| `straight-flush` | Straight Flush | Consecutive ranks (same ace rule as `straight`) and same suit | 48 | 0.002172 | 460.4 | not published (inferred retired) | — |

Pair slugs: `pair-aces, pair-kings, pair-queens, pair-jacks, pair-tens, pair-nines, pair-eights, pair-sevens, pair-sixes, pair-fives, pair-fours, pair-threes, pair-twos`.

Notes:

- `any-trips` and `straight-flush` still exist as slugs, with rule texts and heat-board labels, but the public price table only offers `trips-or-sf`. Keep them in the catalogue and set them inactive by default (see open questions).
- A single flop can win several markets at once. For example, `7h 7d 7s` wins `trips-or-sf` and `rainbow` (three different suits). `5h 6h 7h` wins `any-flush`, `flush-hearts`, `straight`, `trips-or-sf` and `same-color` (and `straight-flush` / `all-lows` where applicable: `5-6-7` is not all low, so `all-lows` loses). Settlement evaluates every market independently.
- Example flops for the rules screen (use these or similar):
  - rainbow `Ah 7s Kd`; same-color `2h 7d Kh`; has-ace `Ah 8d 3s`; any-pair `7h 7s Kd`; any-flush and flush-hearts `2h 7h Kh`; straight `5h 6d 7s`; straight-flush `5h 6h 7h`; all-faces `Ah Kd Js`; all-lows `2h 4d 6s`; any-trips `9h 9s 9d`; trips-or-sf both `9h 9s 9d` and `5h 6h 7h`
  - Specific pairs use two cards of the rank plus a kicker (for example `5h 5s Td`).

### 2.3 Groupings in the UI

- **Rules screen groups**: Main (`rainbow, same-color, has-ace, any-pair`), Specials (`all-faces, all-lows, trips-or-sf`), Flushes (`any-flush` + 4 suits), Runs (`straight`), A specific pair (13 pair markets).
- **Picker filter tabs**: Popular (`rainbow, same-color, any-pair, any-flush, straight, has-ace, all-faces, trips-or-sf, pair-aces, all-lows`), Pairs, Flushes, Colors, Straights, Specials, All. Within a tab, markets are sorted by ascending `payout_odds`.
- **Tournament wizard presets**: Grindy = `rainbow, same-color, has-ace`. Mixed = Grindy + `any-pair, any-flush`. Lottery = all markets.

### 2.4 Price changes

- Only a platform admin can edit a market's price and active flag (13-admin-platform.md). Validation: `payout_odds` must be above 0.
- The admin editor shows `chance`, the fair multiplier, and the edge computed as `1 − (odds + 1) × chance`. A negative edge is highlighted: the club would lose on every Point played.
- **Multipliers lock at placement.** Each bet row stores the odds it was bought at. Price changes apply only to coupons bought afterwards. Live coupons keep their price. The confirm dialog reports how many live coupons include the market and the unresolved amount.

### 2.5 Payout arithmetic

For a winning pick with stake `s` (milli-units) and stored odds `o`:

```
payout = s + floor(s × o)          // total credited, stake included
net win = floor(s × o)
```

For a losing pick the payout is 0. Units are integer milli-Points (or milli-TC / milli-Stars). A coupon's **top win** (shown on the slip) is `Σ_picks (s_i + floor(s_i × o_i)) × rounds`. This is an upper bound: it assumes every pick wins on every flop.

---

## 3. Tables (engine view)

| Field | Meaning |
|---|---|
| `kind` | `cash` (Ring Game) or `tournament` |
| `status` | `open` / `closed` (archived tables are hidden) |
| `dealer_id` | Currently seated dealer, or null |
| `is_auto_deal` | Auto-dealt (Arena, simulation, auto-deal tournament) |
| `allowedBetTypeIds` | Empty list = every active market, including future ones. Otherwise an explicit list with at least one entry |
| `minBetCents` | Minimum per pick per flop. Default 1 PT |
| `maxBetCents` | Maximum per pick per flop. Default 50 PT |
| `maxCouponCommitmentCents` | Maximum total commitment of one coupon. Default 200 PT |
| `marketLimits[]` | Per-market maximum override `{betTypeId, maxStakeCents}` |
| `maxCouponRounds` | Maximum rounds per coupon. Default 20 (inferred default; the client falls back to 20) |
| `couponsEnabled` | Default true |
| `joinCode` | 4–16 alphanumeric, can be regenerated (old QR codes stop working) |
| `game` | `nlh` / `plo` / `other` (lobby card) |
| `featured`, `photo` | Lobby card |
| `room_id`, `club_id` | |

Limit validation (on save):

- Every limit is at least 0.01 PT, with at most 2 decimals.
- max ≥ min. Coupon cap ≥ min.
- A market override is at least the table min.
- Tournament tables reject Ring Game limits: a tournament sets its limits by level.

### 3.1 Automatic per-market limit ("long-shot limit")

When a market has no override, its maximum per pick is derived from the table max and the market's multiplier:

```
mult      = payout_odds + 1
raw       = floor(20 × tableMax / mult)           // in milli-units
if raw ≥ tableMax: autoMax = tableMax
else:
    p = floor(raw / 1000)                         // whole Points
    if p ≥ 10: p = p − (p mod 5)                  // round down to a multiple of 5
    autoMax = max(1, p) × 1000
effectiveMax(market) = max(tableMin, override if set and > 0 else autoMax)
```

With the default table max of 50: ×2.3 through ×16 → 50; ×24 → 40; ×30 → 30; ×60 → 15; ×170 → 5. This reproduces the "5 Points on ×170" rule. Arena ("star" unit) has no per-market cap.

---

## 4. Hand state machine

```
             start-hand                 no-more-bets                enter-flop / scan+confirm
 (none) ───────────────► betting_open ───────────────► betting_closed ─────────────────────────► settled
                            │                              │
                            └──── cancel-hand ─────────────┴──────► cancelled
```

A `pending` status also exists ("waiting"). It is treated as picks not yet open (inferred: a hand created but not opened).

| Transition | Who | Preconditions | Effects |
|---|---|---|---|
| **start-hand** | Seated dealer of the table (or auto-deal engine) | Table open; caller is its dealer; no other live hand (`dealer.hand_live`); club not paused by billing (`commerce.paused_*` / `commerce.game_unavailable`) | Creates hand `hand_number = last + 1`, status `betting_open`. Materializes one round of every live coupon on the table (see §5.4). Emits `hand:started {tableId, handId, handNumber, hand, bettingTimerSeconds?}`. Optional server countdown `bettingTimerSeconds` (the dealer screen shows a ring and turns urgent at ≤5 s) (inferred: an optional auto-close timer) |
| **no-more-bets** | Dealer | Status `betting_open` | Emits `hand:no-more-bets {tableId, countdown}`. Clients show a "NO MORE PICKS" overlay with an optional countdown, then the server sets `betting_closed` and emits `hand:betting-closed` (inferred: a short grace countdown before closing). New coupons placed after close start from the next hand |
| **enter-flop** | Dealer | Status `betting_closed`; 3 valid distinct cards | Stores the cards, emits `hand:flop-revealed {card1..3}`, settles every bet (§6) at once, emits `hand:settled`. Final and irreversible for the dealer. Only a platform admin can void individual bets afterwards |
| **scan-flop** | Dealer | Status `betting_closed` | Returns recognized cards and a confidence for the dealer to review. It does **not** settle. The dealer confirms with enter-flop |
| **cancel-hand** | Dealer | Status `betting_open` or `betting_closed` | Status `cancelled`. Every bet of the hand is refunded. **No coupon round is consumed**: a coupon simply plays the next hand. Emits `hand:cancelled`. Players see "No flop used — single picks refunded" |
| **auto** | Auto-deal engine | See 07/10/11 | Same states, with a random flop and a fixed interval |

Invariants:

- At most one non-final hand per table.
- A dealer cannot leave or switch tables while their hand is live (`dealer.hand_live`, `dealer.held_hand_live`).
- A table cannot be closed or deleted while a hand is live (`table_delete.hand_live`; close preview reports `hasActiveHand` and blocks).
- A settled hand's flop is shown to players exactly as entered ("Players will see exactly these cards. Settlement is final.").

Hand record fields (reports): `hand_number`, `table`, `status`, `card1..3`, `total_bets`, `winning_bets`, `total_wagered_cents`, `total_paid_out_cents`, `settled_at`, `is_tournament`, dealt-by source (`dealer` name / `auto` / unknown for legacy rows), `created_at`.

---

## 5. Coupons

### 5.1 Placement request

`POST /player/coupon`

```json
{ "tableId": "…", "selections": [{ "betTypeId": "…", "stakeCents": 2000 }], "rounds": 10 }
```

Each selection has its own amount per flop. The UI keeps one shared amount and lets the player edit per-pick amounts. Response: `{ couponId, rounds, totalCommitmentCents, balanceCents, unit, isTournament }`.

### 5.2 Server validation (in order; error code in brackets)

1. Table exists (`coupon.table_not_found`) and is open (`coupon.table_closed`). The club is not paused by billing (`commerce.game_unavailable` / paused codes).
2. Membership and play rights: member of the club, play mode not watch-only (`club.play_disabled`), not staff other than owner (`club.play_staff`), not the dealer of this table (`coupon.dealer_own_table`).
3. At least one selection (`coupon.no_selections`), no duplicate market (`coupon.duplicate_selections`).
4. Every market exists and is active (`coupon.selection_unavailable`) and is on the table's or tournament's menu (`coupon.not_on_menu_table` / `coupon.not_on_menu_tournament`, which lists names).
5. `rounds` is an integer ≥ 1 (`coupon.bad_rounds`) and ≤ table max (`coupon.max_rounds_table`). In a tournament, ≤ flops left in the current level and in the tournament (`coupon.max_draws_tournament`; "a coupon cannot outlive its level or the tournament") (inferred: the min of both). `coupon.no_draws_left` if 0.
6. Each stake is a positive integer multiple of the unit (`coupon.bad_stake`), ≥ table/level minimum (`coupon.min_stake`), ≤ table/level maximum (`coupon.max_stake`), ≤ market effective max (`coupon.max_stake_market`).
7. Commitment = Σ stakes × rounds ≤ `maxCouponCommitmentCents` (`coupon.over_commitment`). Not applied in tournaments or the Arena.
8. Funds: Points balance ≥ commitment (`coupon.insufficient_balance`). In tournaments, chips ≥ commitment (`coupon.insufficient_chips`) and commitment ≤ an exposure cap of `pct`% of the current stack (`coupon.over_exposure`; pct is a server parameter, open question).
9. Tournament: registered (`coupon.not_registered`), active and not busted (`coupon.not_active`), levels configured (`coupon.levels_missing`).

On success: debit the whole commitment at once (ledger `coupon_placed`), create the coupon with status `live`, store `odds` per selection, and emit `coupon:placed` to the table room and `balance:updated` to the user.

### 5.3 Rules the player is told

- The amount is **per pick, per flop**. 3 picks × 5 flops = 15 bets. The total is always shown before placing ("Total commitment").
- The first placement per device shows a one-time confirmation ("locked once placed, no cancel").
- **A placed coupon cannot be cancelled** by the player.
- Multipliers are fixed at placement.
- **Start hand**: bought while picks are open, it plays from the current hand. Otherwise it plays from the next hand that opens.
- A **cancelled hand uses no flop** and takes nothing. The coupon plays the next one.
- If the **table closes** with rounds left, the unplayed rounds are refunded automatically. Settled rounds are not.
- Estimated duration shown: about `rounds × 2.2` minutes.
- Tournament short-stack **all-in**: if chips > 0 and chips < level minimum, the player may commit exactly their whole stack (a single pick × 1 round, UI "ALL IN"). The minimum is waived for that case.

### 5.4 Round lifecycle

```
coupon live ──(hand starts on its table)──► round k materialized as bets (status pending)
    │                                         │
    │                          hand settled ──┤──► bets won/lost, payouts credited, coupon:round-settled
    │                          hand cancelled ┘──► bets refunded, round NOT consumed (k stays)
    │
    ├─ after last round settles ─► status completed, coupon:completed {wonCents, committedCents}
    ├─ table closed ─► status voided, refund = Σ stakes × unresolved rounds, coupon:voided {refundCents, roundsUnresolved}
    └─ a selection cancelled ─► that leg's remaining rounds refunded, coupon:leg-cancelled {refundCents}
```

- At `hand:started`, every `live` coupon on the table whose start condition is met gets its next round inserted as bets. The server emits `coupon:round-placed {couponId, handId, bets[]}` to the owner (inferred: emitted to the owning user).
- The debit happens once at placement. Round bets are not debited again. The per-round refund on cancel returns that round to "still to play", not to the balance. **Exception**: bets that are not part of a coupon (legacy "single picks") are refunded to the balance on cancel.
- A leg cancel happens when a market on a live coupon becomes unavailable (removed from the table menu, turned off, or voided by an admin) (inferred). Error codes `coupon.selection_not_on_coupon` and `coupon.selection_already_cancelled` exist for the cancel-leg operation.
- Coupon statuses: `live` (UI "Running"), `completed` ("Finished"), `voided` ("Voided").
- Coupon views: flop-by-flop draws (`GET /player/coupon/:id/draws`) show each round's flop, per-pick won/lost, "In play" and "Cancelled — hand cancelled, no flop used".
- Figures per coupon: committed, won so far, still at stake (unplayed rounds × stakes), `d/n flops`.

### 5.5 Single picks (historic)

Before coupons existed, players placed one pick on the current hand only. The history still shows "Single picks (historic)". Related behaviour:

- Only one pick per market per hand (`already_bet_type`).
- "Repeat last picks".

GetFlop implements coupons only. The history view must still render legacy single picks if migrated data contains them (see open questions).

### 5.6 Play-again

From a finished coupon, "Play again" loads the same picks, amounts and rounds into the slip on the current table:

- Markets not on the table are dropped (n reported).
- Amounts are clamped to the table's limits (n adjusted).
- Rounds are clamped to the table max.
- If no market fits, the player is told. If the player is not at a table, they must join one first.

---

## 6. Settlement

On enter-flop (or an auto flop):

1. Compute the set of winning slugs for the flop (`matchingSlugs`).
2. For each pending bet on the hand: won if its market slug is in the set, otherwise lost. A win credits `stake + floor(stake × odds)` to the wallet (Points / TC / Stars). Ledger `bet_won` (and `bet_placed` / `bet_lost` records per pick) (inferred naming from movement types).
3. Update each coupon's round counter. Emit `coupon:round-settled` per coupon and `coupon:completed` when finished.
4. Emit `hand:settled {tableId, handId, card1..3, matchingSlugs, winners[], losers[], totalPaidOut, totalWagered, isTournament, unit}`:
   - `winners[]`: `{betId, userId, username, betTypeSlug, betTypeName, amountCents, payoutCents, isTournament}`.
   - `losers[]`: the same without the payout.
5. Emit `balance:updated {clubId, balanceCents}` to each affected user.
6. Billing: compute Points played on the hand (Ring Game only) and charge the club play charge (12-billing-commerce.md).
7. Tournaments: update chips, bust players at 0 chips with no rebuy, check level progression and end condition (10-tournaments.md).
8. Arena: badge checks, leaderboard aggregates (11-arena.md).

"Points played" for reports counts each pick when its flop settles. "Put into coupons" counts the commitment when bought. The two differ while coupons are running.

### 6.1 Admin void of a settled pick

A platform admin may void one bet (with a required reason):

- If it lost: the stake is returned to the player.
- If it won: the payout is reversed and the stake returned.

Ledger `bet_refunded` with the reason. The balance is corrected and the action audited.

---

## 7. Auto-play (legacy)

The UI dictionary still contains an older "auto-play" feature:

- It repeated the player's picks every hand.
- It switched off when outside the venue, when level limits were invalid, or on insufficient balance.
- In tournaments it went all-in when the stack fell below the minimum, and raised stakes to the new level minimum.

The current client does not use these strings; coupons replaced auto-play. **Do not implement** unless product asks (open question). A "geo-fence" (verify the player is inside the venue) was part of the same legacy code and is not used either.

---

## 8. Heat board ("Hot & cold")

A per-table statistics panel. It is not a prediction, and the UI must say so.

- **Window**: the last `window` flops (default **50**) of this table. A Ring Game table counts its own history. A tournament counts **only its own hands**, so a new event starts empty.
- **Markets covered** (short labels): Rainbow, Colour, Ace, Pair, Flush, Low, Run, Jack+, Trips, Str flush (plus any others the server includes).
- For each market: `hits` (flops in the window where it won), `hitSeq` (boolean per flop, oldest first), expected rate = probability, and `judged` (whether the tolerance band can be evaluated).
- **Tolerance band** (the dashed band): a market is **hot** if its hit rate is above the band and **cold** if below. Otherwise it is running normally. The band's exact formula is a server parameter (inferred: a binomial confidence band around the expected rate for n = window).
- Display states:
  - `flopsCounted < 10`: "not enough flops yet".
  - `10 ≤ flopsCounted < window`: dimmed bars, "the window fills as the table plays; nothing is called hot or cold until there are 50 flops".
  - Full window, no hot or cold: "every bar inside the band".
  - Otherwise a hot list and a cold list, each with a bead strip showing where the hits fell.
- Headline sentence: "X and Y have been showing. Z has gone quiet." / "Nothing out of the ordinary" / "n hands in, give me a few more".
- Help accordion (5 Q&As): what a bar is, what the band is, numbers and dots, "does this predict?" (no), which hands count.
- API: `GET /player/table/:id/heat` → `{ window, flopsCounted, markets[{slug,name,hits,expected,judged,hitSeq}], hot[], cold[] }` (inferred shape).

---

## 9. Participation (tournaments), summary

See 10-tournaments.md. In short: a player must have action in at least `minActionPct`% of the tournament's hands. One coupon counts for every flop it covers.

---

## 10. Open engine questions

- Exact `bettingTimerSeconds` and no-more-bets grace countdown values, and whether picks auto-close when the timer ends.
- The tournament exposure cap percentage.
- The heat tolerance-band formula.
- Whether `any-trips` and `straight-flush` should be offered.
