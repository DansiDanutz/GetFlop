# 07 · Inspector: Floor, Tables, Requests, Reports

The staff surface (`#/inspector`) is available to inspectors, managers and owners. It sits under the **Tables**, **Requests** and **Reports** tabs of the staff navigation. Members and Club are covered in 08.

## 1. Floor (Tables tab → Ring Games)

Data:

- `GET /inspector/dashboard` → `{stats, tables[]}`.
- `GET /inspector/tables` → table rows with `id, name, kind, status, dealer_id, dealer_name, active_hand_status, active_hand_number, live_coupons, coupon_exposure_cents, total_hands, last_hand_at, is_auto_deal, is_simulation, room_id, created_at, tournament_status, tournament_name, tournament_scheduled_at, join_code`.
- Also: `GET /inspector/requests`, `GET /clubs/:id/join-requests`, `GET /inspector/wallet-drift`, `GET /clubs/:id/setup`.
- Refresh: every 30 s, on any `floor:changed` (debounced 1.2 s), on reconnect, and on request and dealer-sit events.

### 1.1 Attention list ("NEEDS YOU · n")

The list is built in this priority order. When it is empty the floor shows **ALL CLEAR**, "n tables dealing · nothing pending".

| Severity | Condition | Row | Action |
|---|---|---|---|
| danger | Club is level-locked (second free club) | "Needs a paid Club Level" | Owner: Change Level |
| danger | Pending Points requests (in or out) > 0 | "Requests waiting · n" | Open Requests |
| danger | Simulation budget tripped | "Simulation stopped — database budget reached" (reason: over 200,000 picks or DB over 1 GB) | Open simulation |
| danger | Each open, non-auto table with **no dealer** | "<table> · open with no dealer — nobody can deal" | Assign dealer |
| attention | Drift check could not run | "Balance check · could not run — unknown, not a sign all is well" | — |
| danger | Drift count > 0 | "n player balances do not add up · largest X" | — |
| attention | Open non-auto table with a dealer, no live hand, and `now − last_hand_at ≥ 8 min` | "<table> · No hand for <duration> · <dealer>" | Open table |
| waiting | Upcoming tournament with `0 ≤ scheduled_at − now ≤ 10 min` | "<tournament> · starts in <n>" | Open Tournaments |

Durations render as "n min", "h h m min" under 48 h, else "n days".

### 1.2 Setup "next step" card

Owner, manager, or anyone with the settings surface. See 03 §3.

### 1.3 Table groups

Rows are grouped in this order. Each table appears once.

1. **READY — OPEN WITH A DEALER**: closed Ring Game table, not simulation, 0 hands ever, created within 14 days. Button "Open".
2. **NO DEALER**: open, no dealer, not auto. Button "Assign a dealer".
3. **DEALING**: open with a live hand.
4. **OPEN, WAITING**: open with a dealer, no live hand.
5. **AUTO-DEAL**: open auto-deal tables.
6. **CLOSED**: folded behind "Show closed tables (n)".
7. **OTHER**.

Row sub-lines: "n hands", "n live coupons · exposure", "last hand <d> ago".

A **New table** button sits at the top.

## 2. Tables CRUD

### 2.1 Create

`POST /inspector/table {name, roomId?, allowedBetTypeIds?, minBetCents?, maxBetCents?, maxCouponCommitmentCents?}`

- Name placeholder "e.g. Main Table". Room picker if the club has several rooms.
- "Allowed markets": all ticked means every market (empty list sent). At least one is required ("The table needs at least one market").
- Limits are only sent by users with the settings surface (owner or manager). Defaults are 1 / 50 / 200.
- The table is created **closed**. Toast "Table <name> created".
- If the club has no dealer yet: "No dealer in this club yet" with "Open Members" (manager+) or "I'll deal myself".

### 2.2 Open

`PUT /inspector/table/:id/open {dealerId, leaveHeld?}`

- A dealer must be chosen. The picker lists club dealers, marking "already on <table>" or "at another table right now". The option "Me — I'll deal" grants the owner or manager the dealer role and seats them ("You deal <table> … you cannot play on the table you deal", with a "Dealer screen" button).
- Level capacity: Ring Games open at once ≤ the Level limit (`commerce.capacity_ring_games_*`). Level-locked and paused clubs cannot open tables.
- If the selected dealer is seated elsewhere, the confirm flow offers to stand them up there (inferred; the response carries `left`).
- Toast "Table opened successfully!"

### 2.3 Close

- First `GET /inspector/table/:id/close-preview` → `{table{kind}, hasActiveHand, activeHandNumber, couponCount, playerCount, totalRefundCents, coupons[{player, drawsLeft, refund}], tournamentName?}`.
- Cases:
  - **Hand live**: blocked. "Hand #n is still live — settle or cancel it first; closing now would strand picks nobody can settle."
  - **Tournament table**: "no Ring Game coupons ride here, nothing voided". If a tournament is running on it: "closing the table does not end the tournament".
  - **No coupons**: "Nothing will be voided or refunded."
  - **Coupons**: headline refund total and "c live coupons · p players", a list with "n flops left" each, and "Refunded for the flops that have not been dealt; flops already settled are not refunded."
- Button: "Close · refund X" or "Close the table".
- `PUT /inspector/table/:id/close`: voids live coupons (`coupon:voided`), refunds unplayed rounds, unseats the dealer, and sets status closed.

### 2.4 Delete / archive

- `GET /inspector/table/:id/delete-preview` → `{mode: "delete"|"archive", history{hands, coupons}, dealer?, blocked?{code, params}}`.
  - Never played: deleted for good, with markets and limits.
  - Played: **archived**. It disappears from the Floor, lobby and lists, and its history stays in reports (hands n, coupons n).
  - A seated dealer is stood up first.
  - Blockers: `table_delete.tournament {tournament}`, `table_delete.hand_live {hand}`, `table_delete.coupons_riding {n}`, `table_delete.changed`.
- `DELETE /inspector/table/:id`. Toasts "<name> is deleted" / "… its history is kept".

### 2.5 Table sheet (row "⋯")

Actions:

- Open / Close.
- Assign a dealer / Stand the dealer up: `POST /inspector/table/:id/assign {dealerId}`, `POST /inspector/table/:id/unseat`. The unseat confirm says the table stays open without a dealer and the dealer's screen is told.
- **All markets & limits**:
  - Markets: `GET/PUT /inspector/table/:id/bet-types {allowedBetTypeIds}`, all ticked sends `[]`.
  - Limits: `PUT /inspector/table/:id/limits {minBetCents, maxBetCents, maxCouponCommitmentCents, marketLimits:[{betTypeId, maxStakeCents}]}`. Only owner or manager ("Only the owner or a manager can change the limits per pick"). Others see read-only values.
  - Empty market fields show the automatic limit as a placeholder (`≤ n`) that updates live as min and max change (01 §3.1).
  - Select all / Clear / count "k/n".
- **Card in the lobby**: `PUT /inspector/table/:id/lobby-card {game: "nlh"|"plo"|"other", featured: bool, photo?: image|null}`.
  - Featured shows the card first. Without a photo the card shows a drawn felt.
  - Photo JPEG/PNG/WebP, size-capped. Tournaments have their own card (`table_card.tournament`).
- **Table QR**: shows the join code and QR of `<app>/#/join/<code>`. Owner or manager can regenerate with `POST /tables/:id/generate-code` → `{joinCode}`. The warning says every printed QR stops working.
- **Ring Game TV** (09).
- **Delete table**.

## 3. Requests tab

See 04 §6 for Points requests, 03 §4.2 for join requests and 05 §2.3 for dealer seat requests.

- Pending view: Points in / Points out / Join requests / Dealer seat requests, each with player, amount, current balance, time, and Approve / Reject.
- The nav badge counts pending Points requests + join requests + dealer sit requests.
- History view: last 30 days.
- Toasts: "Pending Approvals" on `request:new` / `join-request:new`, and "A dealer is asking to sit" on `dealer-sit:new`.

## 4. Reports tab

Segments: **Live · Hands · Analytics · Report · Club** (Club only for owner or manager).

### 4.1 Live

- `GET /inspector/live/bets?tz&tableId&wins=1&big=1` and `GET /inspector/live/points?tz&actor=me|<userId>`.
- It polls every 15 s and on `live:changed {kind}`, `floor:changed` and `request:resolved`. A "↑ n new" pill appears when the list is scrolled.
- **Window**: the current session ("Shift n · since hh:mm") or, with no session, "Today since hh:mm".
- **Coupons view**:
  - Strip: Played, Won by players, Club (+/−).
  - Rows: player (tap to open their card, with back to Live), table, picks with flop k/n, "In progress" / "Won X" / "Lost X" / "Voided", "n flops", time.
  - Filters: All tables / a table, Only wins, "≥ N PTS" (the club's big threshold).
  - Rows at or above the big threshold are highlighted.
- **Points movements view**:
  - Strip: Given, Taken back, Net.
  - Rows: Send Out / Claim Back / "Points request" (approved) / "Return", with amount, "by you / by <name> / by the player / approved by …".
  - Filter: All staff / Mine only / a staff member. Inspectors default to "Mine only".
- CSV export of the current view. A note says tournament chips are not in these totals. Empty and error states.

### 4.2 Hands

- `GET /inspector/results?tableId&dateStart&dateEnd&tz` → `hands[]`.
- The period chips are Today, 7 days, 30 days, All and custom dates, plus a table picker (open or closed tables, with search).
- Rows: Hand #, table, flop, picks W/T, played, player wins, hold, time, and a tournament tag (tournament amounts shown in TC).
- Only the latest n are shown; narrow the search to see more.
- Hand detail: `GET /inspector/hands/:handId` → dealt by (name or Auto-deal), players with "played s · won w", and each pick (market, amount, Won / Lost / Refunded / Open). "Nobody played this hand". Tournament hands carry a chips note.
- CSV columns: `Hand, Table, Kind (cash|tournament), Card1, Card2, Card3, Bets, Winning bets, Played PTS, Won by players PTS, Club result PTS, Played TC, Won by players TC, Date(ISO)`.

### 4.3 Summary ("Results & Reports")

`GET /inspector/summary?tableId&dateStart&dateEnd&all&tz`:

- KPIs: hands, Points played, won by players, club result, tournaments (entries, collected, prizes).
- Per room, per table (idle tables counted), per market (actual hold compared with expected), per player (won, in, out, balance).
- Notes that TC is excluded and that tournament Points belong to the club, not a table.

### 4.4 Analytics

- Sessions: `GET /inspector/session` → `{open, recent[]}`. `POST /inspector/session/open`, `POST /inspector/session/close`.
  - A session runs from when the floor opens it until it is closed. **If nobody closes it, it closes itself at 06:00** (club local time).
  - Closing shows a summary (hands, players, handle, result) and **starts the next session at once**.
  - With no session open: "Start a session".
- Scope: Session n (open or past), Last 24 hours, Last 7 days, Everything recorded. Anything dealt before the first session belongs to none.
- `GET /inspector/analytics?sessionId | from&to &includeBots=1 &source=auto|dealer`:
  - Handle, Gross win (GGR), Hold %, Hands, "b picks · p players".
  - **By market**: hit count compared with expected, hold compared with theoretical, with a 95% interval bar. "Too few picks to read a hold" when volume is low. Markets inside the normal band are collapsed into one line ("n markets inside the expected range").
  - **By dealer**: hands, picks, handle, compared with theoretical. Auto-deal is tagged AUTO.
  - **By table**.
  - The "Dealt by" filter is Anyone / Auto-deal / A dealer. Legacy hands with no source are counted separately ("not recorded").
  - Toggle "Include simulation".
  - Balance check result (04 §9).

### 4.5 Shift report ("Report")

- `GET /inspector/report?fromDatetime&toDatetime&tableIds` (tables optional; blank means all). Errors `report.range_invalid`, `report.range_order`.
- Sections:
  - Points in / out, net Points.
  - Total played, total player wins, house hold.
  - Tournaments (entries, buy-ins + fees, rebuys, add-ons, prizes paid, result).
  - By market: Ring Games (actual compared with theoretical hold) and tournament chips separately.
  - By room, by table, by player (won, in, out, balance).
- **Generate Report** button, CSV export.

### 4.6 Club report (owner / manager, 30-day default)

`GET /inspector/club-report?dateStart&dateEnd&all&tz`. Ring Game hands and real players only:

- **Results**: flops dealt, Points played, won by players, club result, still riding on live coupons (n coupons now).
- **Players**: Active (bought a coupon), New (joined in the period), Returning (played, and were members before). **Top 10 by Points played**, each with picks and club result, tap for the card.
- **Points in the period**: new Points issued, sent to players, returned by players, put into coupons, won by players, refunded, tournament entries, tournament prizes, players hold now, club holds now. Note the difference between "put into coupons" and "played".
- **Diamonds in the period**: spent on Points (legacy), on play, on the Level, with "pts played · D" and "measured, not charged" in pilot. Link to the Club account.

## 5. Tournaments tab

See 10-tournaments.md (control panel, wizard, monitor, logs, report, TV, pin, auto-deal).

## 6. Players search (staff)

- A list of RECENT players (played or moved Points) and RESULTS for a search by name or username.
- Each row has a "Send" quick action and "request waiting" markers.
- "Scan player QR" is the fastest way to the person in front of you.
- "n more — search by name or username".

## 7. Simulation (platform "FlopMe Club" only)

Visible only in the simulation club (`err_simulation_club_unsupported` elsewhere). Endpoints:

- `GET /simulation/status`, `GET /simulation/bots`, `GET /simulation/report`, `GET /simulation/budget`.
- `POST /simulation/table` creates a simulation table.
- `POST /simulation/start {tableId, botIds[], autoApprove}` and `POST /simulation/stop`.
- `POST /simulation/auto-approve {enabled}` auto-approves bot Points requests.
- `POST /simulation/table/:id/new-hand`, `.../no-more-bets`, `.../deal [cards?]` for manual stepping ("Deal & Settle"). The player-side `POST /player/table/:id/sim-step` exists too.
- `POST /simulation/purge` resets simulation data (ledger `sim_reset`).
- **Budget guard**: at most **200,000 stored picks** or **1 GB database**. When exceeded, every auto-deal table stops (floor danger row). Simulation data older than N days is deleted nightly. `POST /simulation/budget/release` lets auto-deal run again, and fails with `simulation.budget_exceeded` if still over.
- The report lists bots (persona label, picks, W/L, balance) and hand controls.
- Simulation rows are excluded from every financial report unless "Include simulation" is on.

## 8. Welcome and coach marks for staff

- Inspector: "Whatever needs you comes first".
- Coach marks: Requests, then Members, then identity.
