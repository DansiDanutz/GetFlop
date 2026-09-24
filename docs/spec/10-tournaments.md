# 10 · Tournaments ("FlopMe tournaments")

A promotional format. Each entrant pays a fixed buy-in in **Points** and gets a fixed stack of **tournament chips (TC)**. They make picks in TC on a dedicated tournament table. Prizes are paid in Points by final chip standings.

The only format supported in production is **freezeout**. Rebuys and add-ons exist but are flagged "leave off unless you are testing".

Tournaments require a Club Level that includes them (Club 100 and above). The number running at once is capped by the Level (`commerce.level_tournaments_unavailable_*`, `commerce.capacity_tournaments_*`).

## 1. Data model

| Field | Notes |
|---|---|
| `name` | Required, safe characters |
| `clubId`, `tableId` | An existing free tournament table, or "Create a table for it" (auto-created table of kind `tournament`). A table can host only one upcoming or active tournament (`trm.table_busy`) |
| `dealerId` **xor** `autoDealSeconds` | Human dealer, or auto-deal every 5–120 s (default 20). Both or neither is an error (`trm.dealer_or_auto`) |
| `scheduledAt` | Optional. Shown in the lobby. Starting stays manual unless `autoStart` |
| `autoStart` | Server supports an automatic start at `scheduledAt` (`trm.autostart_needs_time`). Not exposed in the wizard (open question) |
| `pinned` | Pinned to the top of the player lobby |
| `botsAllowed` | Auto-register simulation bots (test events only; shown only in the simulation club) |
| `buyInCents`, `feeCents` | Points. Default 5,000 / 500. Free entry if both are 0 |
| `startingStack` | TC. Default 10,000 |
| `allowRebuys`, `maxRebuys` (−1 = unlimited), `rebuyStack` (10,000), `rebuyCostCents` (5,000), `rebuyFeeCents` (0), `rebuyEndHand` (30) | Rebuy only on a 0 TC stack |
| `allowAddons`, `addonCostCents` (5,000), `addonStack` (15,000), `addonEndHand` (defaults to rebuyEndHand+1 = 31) | "The add-on is one break": it opens after the rebuy period |
| `minActionPct` | Participation 0–100 (default **50**; 0 = off) |
| `allowLateRegistration` (default on), `lateRegEndHand` (default 10) | |
| `allowedBetTypeIds` | Markets. Presets Grindy / Mixed / Lottery. The wizard shows "Biggest win on one hand: +max(odds)×" |
| `levels[]` | `{levelNumber, minBetChips, maxBetChips (−1 = no max), endHand}` |
| `prizePoolType` | `guaranteed` (with `guaranteedPrizeCents`, default 50,000) or `progressive` (from entries, rebuys and add-ons) |
| `payoutStructure` | Percentages, biggest first, summing to 100 (default `50, 30, 20`) |
| `endCondition` | `hands` (`endValue` = total hands, default 50) or `manual` (`endValue` 9999) |
| `status` | `upcoming` → `active` → `finished`, or `cancelled` |

Default levels (wizard):

| Level | Min per pick (TC) | End hand |
|---|---|---|
| 1 | 100 | 10 |
| 2 | 200 | 20 |
| 3 | 500 | 30 |
| 4 | 1,000 | 40 |
| 5 | 2,000 | 50 |

"Add level" doubles the previous min and adds 10 hands. "Remove last" keeps at least one level. The wizard sends `maxBetChips = −1` ("There is no maximum — a player can always go all-in; variance is controlled by the markets").

## 2. Wizard (5 steps)

The steps are **Info → Stack → Rebuys/Addons → Levels → Prizes**, with Back / Next and a final "Create tournament". Client checks: name present (else jump to step 1), and a dealer chosen when mode is human (else step 1). Dealers busy at another table are disabled in the picker.

Server validation (`POST /tournaments`):

- `trm.create_missing` (name and ≥1 level)
- `trm.name_damaged`
- `trm.levels_required`
- `trm.levels_order` (levels must be numbered 1, 2, 3…)
- `trm.level_end_invalid` (end hand is an integer ≥1)
- `trm.level_end_order` (each end hand > the previous)
- `trm.level_min_invalid` (min > 0, ≤2 decimals)
- `trm.level_max_below`
- `trm.levels_short` (the last level must reach the tournament's final hand)
- `trm.min_action_invalid` (integer 0–100)
- `trm.latereg_after_end`
- **`trm.latereg_too_late`**: with participation p% over T hands, a player needs `need = ceil(p × T / 100)` hands (inferred rounding). Late registration must close by hand `last = T − need + 1`.
- `trm.addon_before_open` (addonEndHand < rebuyEndHand), `trm.addon_after_end`
- `trm.payouts_empty`, `trm.payouts_not_numbers`, `trm.payouts_sum`
- `trm.scheduled_invalid`, `trm.autostart_needs_time`, `trm.dealer_or_auto`, `trm.table_busy`

## 3. Lifecycle and staff controls (Tournaments segment)

Control panel lists (Upcoming / Live / Finished). Each row shows name, club/table, buy-in + fee, prize pool ("X (GTD)" or "Grows · now X"), registered count, status, start ("Starts <when>" / "No start time — starts when you start it" / "Started" / "Finished"). Actions:

| Action | Endpoint | Rules |
|---|---|---|
| Pin / unpin | `POST /tournaments/:id/pin` | Toggle. Toast "Pinned to the top of the player lobby" |
| Start | `POST /tournaments/:id/start` | Confirm "can't be undone: registration closes and play begins" (late registration may stay open). Tournament capacity checked. Registered players get `tournament:started` and are seated automatically if their screen is open |
| Cancel | `POST /tournaments/:id/cancel` | All buy-ins and fees refunded (`tournament_refund`). Emits `tournament:cancelled` |
| Finish | `POST /tournaments/:id/finish` | Ends now. Prizes awarded by current standings. Emits `tournament:finished` |
| Auto-deal | `POST /tournaments/:id/auto-deal {intervalSeconds}` / `DELETE` | "Dealing a random hand every n s — bots play automatically; stops on its own when the tournament ends". Starts with the tournament when configured, and resumes after a server restart |
| Monitor | `GET /tournaments/:id/monitor` | See §7 |
| Logs | `GET /tournaments/:id/logs` | Event log (bot telemetry, most recent first, severity Error/Warning) |
| Report | `GET /tournaments/:id/report` | See §9 |
| TV | 09 | |

Automatic end: after `endValue` hands when `endCondition = hands`. Level progression is automatic by hand number and emits `tournament:level:updated {levelNumber, minBetChips, maxBetChips}`.

## 4. Registration (players)

- The lobby card and detail (`GET /tournaments`, `GET /tournaments/:id`) show buy-in, starting stack, levels, prize pool, payouts, entrants, late reg ("Late registration closes / closed"), rebuys ("Until hand n" / "Not allowed"), add-on, and ends ("After n hands" / "Manual").
- **Register**: `POST /tournaments/:id/register`. The confirm shows "X (buy-in + fee)" or "Free entry", then:
  - before start, manual start: "You can unregister, with a full refund, until it starts"
  - auto start: "…until 1 minute before the start"
  - already running (late registration): "this entry is final"
- Errors:
  - `trm.not_found`, `trm.registration_closed`, `trm.already_registered`
  - `trm.no_wallet`
  - `trm.insufficient_balance {amount}`
  - play-mode and staff blocks (`club.play_disabled`, `club.play_staff`)
  - `commerce.tournament_unavailable` / `commerce.tournament_waiting`
- Ledger `tournament_buyin` (buy-in + fee). The club play charge applies to the buy-in (12).
- **Unregister**: `POST /tournaments/:id/unregister`. Full refund of buy-in + fee. Allowed until start (manual), or until 1 minute before `scheduledAt` (auto-start: `trm.unregister_cutoff {minutes}`). After start: `trm.unregister_started`.
- "You're registered. Keep this screen open to be seated automatically when it starts."
- Events: `tournament:registered`, `tournament:unregistered`.

## 5. Play

- Picks use TC with the level's min per pick and **no max**. The per-market automatic limit does not apply (inferred). The table's allowed markets = the tournament's markets.
- Coupons are allowed, but rounds ≤ min(hands left in the level, hands left in the tournament) (`coupon.max_draws_tournament`).
- **All-in**: if 0 < stack < level minimum, the player may commit the whole stack on one pick for one round.
- **Exposure cap**: commitment ≤ pct% of the stack (`coupon.over_exposure`; pct is a server parameter).
- A win credits TC. Chips update via `tournament:chips:updated {tournamentId, chips}`.
- **Bust**: stack 0 and no rebuy available ends the player (`tournament:player:busted {tournamentId, username}`). With a rebuy available: "Out of chips — you can rebuy" (cost, chips, rebuys used).
- **Rebuy**: `POST /tournaments/:id/rebuy`. Only at 0 TC (`trm.rebuy_needs_zero`), only while hand ≤ rebuyEndHand (`trm.rebuy_period_ended`), up to maxRebuys (`trm.max_rebuys`), and only if allowed (`trm.rebuys_not_allowed`). Charges cost + fee, adds rebuyStack. Ledger `tournament_rebuy`.
- **Add-on**: `POST /tournaments/:id/addon`. Once per player (`trm.addon_already_taken`), in the window after the rebuy period up to addonEndHand (`trm.addon_not_started`, `trm.addon_ended`), active players only (`trm.addon_needs_active`) with chips > 0 (`trm.addon_no_chips`), if allowed (`trm.addons_not_allowed`). Adds addonStack. Ledger `tournament_addon`.
- Other errors: `trm.not_active` (not running), `trm.not_registered`.

## 6. Participation rule (VPIP)

- `required = ceil(minActionPct × T / 100)` hands with action, where T = total hands (inferred rounding).
- A hand counts as "played" if the player had at least one pick settled or cancelled on it. **One coupon counts for every flop it runs for.**
- Tracked per player:
  - `done` (hands with action)
  - `dealt` (hands dealt while the player was entered)
  - `remaining = T − current hand`
  - `more = max(0, required − done)`
  - `spare = remaining − more`
- Status for the UI:
  - good
  - warn when `vpipPct < minActionPct + 10` or `spare ≤ 3`
  - bad when `spare ≤ 0` or below the requirement
  - "LAST CHANCE" when every remaining hand counts
- **Elimination**: when `done + remaining < required`, the player is out ("participation requirement not met"). Their chips stay on the board as their **finishing stack** (they still rank by chips; inferred: ranked among eliminated players by chips) and the reason is recorded (`eliminatedReason = participation`).
- Players see: "VPIP p% — play at least r of e hands or you are out", the meter, "You can sit out s more", "Getting tight — you must play m of the last k", "Out".
- The my-games chip warns "Play within n flops" / "Play now — 1 flop left".

## 7. Monitor (staff)

- Header: "Level L (min x chips) · Hand h", late-reg open badge, auto-deal status and controls.
- KPIs: Entrants, In play, Eliminated, Avg stack, Chip leader, Prize pool.
- Standings table: rank, player (bot badge), chips, IN/OUT, out on hand, prize, rebuys/add-ons, "no chips" / "too little play".
- Live hand panel (from socket): status, cards, the bet list (`bet:placed {tableId, handId, username, betTypeName, amountCents, isTournament}`), cancelled count, winners and losers, total paid out.
- Refreshes on registration, bust, finish, chips and settle events.

## 8. Standings (player)

- My position ("r of n left"), stack, average, leader, field. "Prizes p · n prize places".
- The "Prizes end here" line marks the bubble.
- Distance messages:
  - Outside the prizes: "p places and n TC from the prizes".
  - Inside: "<pay> locked up · n TC to the place above", or "chip leader".
  - Everyone left wins: "Everyone left wins a prize".
  - **Bubble**: "One player leaves with nothing, and right now it is you. n TC puts you in the prizes."
- Final standings: entrants, pool, my finish ("Out in nth"), hands played, prize or "No prize".

## 9. Prize pool and payouts

- **Progressive**: pool = Σ buy-ins + rebuy costs + add-on costs (fees go to the club).
- **Guaranteed**: pool = `guaranteedPrizeCents`. Pool Points are **reserved** in the club ("Reserved for tournament guarantees"). If collected exceeds the GTD, the pool follows the progressive amount (inferred: max(GTD, collected), see open questions).
- Payout for place k = pool × pct_k / 100 (rounding to the unit; remainder to 1st, inferred). Places beyond the number of entrants are unpaid, and their share returns to the club (inferred).
- Ties on chips: open question (suggest earlier bust ranks lower; equal chips at finish split the combined prizes).
- Paid as ledger `tournament_payout` to the winners' Points wallets at finish.

## 10. Report

`GET /tournaments/:id/report`:

- Duration (h, min), chips played, chips kept.
- Standings with prizes.
- Players: picks, avg, net, "out" reason.
- Biggest hits (name, hand, market, "on <stake>").
- By market: picks, won, played, chips kept compared with expected.
- The note says TC are not Points, and prizes are Points.

## 11. Lobby placement

- Pinned tournaments appear first.
- Club tiles show "Running", "Today hh:mm", or "None yet".
- The detail page has a countdown to `scheduledAt` ("Starting soon…"). Upcoming and running tournaments also show on my-games (starting soon: "in n min").
- The tournament table in the lobby uses its own card (not editable via lobby-card).

## 12. Money flows summary

| Event | Player Points | Club |
|---|---|---|
| Register | −(buy-in + fee) | +(buy-in + fee) collected; play charge on buy-in |
| Unregister / cancel | +(buy-in + fee) | − the same; "entry given back" play charge refund |
| Rebuy / add-on | −(cost + fee) | + |
| Finish | + prize | − prizes |
| Tournament result | — | collected − prizes (reported as "Tournament result") |
