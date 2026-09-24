# 13 · Platform Admin

Accounts with `role = admin`. Navigation: **Platform · Clubs · Accounts · Commerce · More** (`#/admin…`). Admin screens refresh every 30 s while visible and on reconnect. Every admin mutation is written to the audit log.

## 1. Platform overview (`GET /admin/platform?dateStart&dateEnd&tz`)

Period chips: Today / 7 days / 30 days / All.

- **Health**: "Database answering in n ms · n live connections".
- **KPIs**: hands dealt (in n clubs), players who played, coupons bought, live coupons right now, clubs, tables open.
- **Online now**: n connected, n at tables, split into lobby/browsing, per table and tournament (inferred).
- **Devices & app installs**: each player's device, app installed or browser, logins today. Headline "n with the app installed · n logins today".
- **Clubs**: per club (money is **never added across clubs**, because each club's Points are its own):
  - hands, players, Points played (settled), won by players, club result, still riding on live coupons
  - players only; bots and simulation tables are left out
  - "n clubs with no play in this period"
  - link "Members and account"
- **Markets** (all clubs): settled picks, hits, and the rate priced for. Verdict:
  - "hitting more than priced" / "less than priced" / "as priced"
  - "under 50 picks: too few to judge"
  - uses a **Wilson 95% interval** (z = 1.96) around the observed hit rate compared with the priced probability
  - "retired" markets are marked
  - "All markets (n)" / "Show fewer"

## 2. Clubs (commerce clubs list)

- `GET /commerce/admin/clubs` lists clubs (search by name or ID, total count). Columns: Diamonds, unpaid, Level, renews, state, billing (on / free pilot), members, Diamond requests pending.
- The billing start banner and controls are described in 12 §4.
- Per club (`GET /commerce/admin/clubs/:id`):
  - Diamonds, this period's usage ("pts played → D", preview, "measured before charges began (not charged)")
  - Points pool, limits (members, Ring Games, tournaments, broadcasts), Diamond movements (ledger)
  - **Enforce billing / Back to free pilot**
  - **Top up**: `POST /commerce/admin/clubs/:id/topup {diamonds (whole number), reference (required), note?, requestId?}` with `Idempotency-Key`. Unpaid charges are settled first. Toast: "d added · balance b (· n unpaid charge(s) settled)". Errors `aclub_err_diamonds`, `aclub_err_reference`.
  - Reject a Diamond request.
  - **Members**: `#/club/members/<clubId>`, "every member, their card, and the club's Points supply". The admin sees the member list and member cards of any club (`#/club/card/<clubId>/<userId>`).
- Restore a deleted club (03 §12).

## 3. Accounts (`#/admin/accounts`)

- `GET /admin/accounts?filter=all|admins|inactive|bots&q&limit=50&offset` → `{accounts[], total, counts{all, admins, inactive, bots}}`.
  - Search by name, @username or email. "Show n more".
  - Row badges: Admin, Deactivated, Bot. Club names, or "No club".
- **Account detail** (`GET /admin/players/:id/detail`):
  - status, type, created ("On FlopMe since"), last seen, signs in with (PIN / Google), email (not verified), clubs
  - **In each club**: status (member / asked to join / left / removed / not accepted) and hands. Each club's Points are separate, and the admin opens a club to see that member card.
  - **Movements**: ledger across clubs with "balance after".
  - **Picks**: "All (n)".
  - A CSV download of movements and picks (inferred).
- **Create**: `POST /admin/users {username, displayName, role: "player"|"admin", pin}`.
  - Creating an admin needs an extra confirmation.
  - Players join clubs from the app. Staff roles are given inside a club.
  - Errors: `admin.create_missing`, `admin.username_taken`, `admin.pin_digits` (4–8), `admin.name_length` (1–30), `admin.role_invalid`.
- **Edit**: `PUT /admin/users/:id {username, displayName}`.
- **Reset PIN**: `PUT /admin/users/:id/reset-pin {newPin}`. The admin tells the person the PIN. The user's current sign-in stays open.
- **Deactivate / reactivate**: `PUT /admin/users/:id/toggle-active {active}`. Deactivation signs the user out at once and blocks sign-in. Points, coupons and history stay. An admin cannot deactivate themselves (`admin.self_deactivate`). `admin.user_not_found`.
- User list (`GET /admin/users`) is a legacy list endpoint used by the older user table.

## 4. Live (`GET /admin/live`)

Live overview across clubs: tables with active hands, current picks and coupons (inferred; "Live Dashboard Overview", "Live Tables Monitor").

## 5. Hand history (More → Hand history)

- `GET /admin/tables` returns all tables across clubs, used for the picker (search "Club or table").
- `GET /admin/hands?tz&dateStart&dateEnd&tableId&handNumber` → `hands[]` (the latest n; narrow down to see more).
  - Row: hand no., table (Ring Game / Tournament), flop, "picks n · status" (settled / cancelled / picks open / picks closed / waiting), played, paid, result.
- `GET /admin/hands/:id/bets`: every pick with player, market, amount, status (won / lost / open / voided / cancelled).
- **Void a pick**: `POST /admin/bets/:id/void {reason}`. The reason is **required** (for example "the dealer entered the wrong cards").
  - Lost pick: the stake goes back to the player.
  - Won pick: the win is taken back and the stake returned.
  - Toast "The pick of <name> is voided and the balance corrected". Ledger `bet_refunded`. Audit entry.

## 6. Reconciliation (More → Reconciliation)

- `GET /admin/financials/reconciliation` returns **club days**: each club on its own club days, with settled Ring Game picks and the Points it sent and took back. Clubs are never added together.
  - Row: date, club, picks, played, won by players, club result, Points sent to players, Points claimed back.
  - Daily summary and CSV export.
- `GET /admin/financials/daily-player-net` returns **players today**: in, out, balance, played, per player. "All players (n)". Empty state "No player has played today".

## 7. Audit log (More → Audit log)

- `GET /admin/audit?page&limit=50&action=` → `{logs[], pagination{page, totalPages, total}}`. Filter by action (for example `deactivate_user`). Newer / Older paging.
- Entry: action (localized `audit_action_<action>` or raw), actor, entity ("On"), time, details.
- Must capture at least:
  - all admin account actions
  - club deletions and restores
  - role changes and ownership transfers
  - Points mints, stock moves, Send Out / Claim Back
  - request decisions
  - table open/close/delete, limits and markets changes
  - tournament lifecycle
  - bet voids, market price changes
  - billing enforcement, top-ups, refunds, catalogue changes (the commerce audit is separate, see 12 §10.4)

## 8. Market matrix (More → Market matrix)

- `GET /admin/bet-types` → every market with `payout_odds`, `probability`, `fair_odds`, `is_active`, live coupon count and unresolved amount.
  - Row: name, `×(odds+1)`, "edge e · chance p", "n live coupons", "off".
- Edit sheet:
  - "Pays (X:1)" (must be > 0), "Chance of hitting" (%), "Fair multiplier (X:1)", "House edge" (computed `1 − (pays+1) × chance`; negative means the club loses on every Point played), "On the board" toggle.
  - The note explains that a price change applies to coupons bought afterwards, and live coupons keep their price.
- `PUT /admin/bet-types/:id {payout_odds, probability?, fair_odds?, is_active}`. The confirm lists the price change, the edge change, on or off the board, and "live coupons keep the price they were bought at". It is highlighted when the edge is negative.

## 9. FlopMe Arena report (More → FlopMe Arena)

`GET /admin/platform/arena?period=day|week|month|all`. "The Arena is outside every club number and every commercial figure."

- **Stars (all time)**: granted, bought, in wallets, house holds (= granted + bought − wallets). In the period: granted, refilled, bought.
- **Star sales** (Star packs only; Diamond revenue is reported elsewhere): orders, buyers, charged, VAT (inside the price), kept, per pack (orders, ★).
- **Play** (clamped to the retention window): hands, played, paid out, hold ("Not enough yet" if too few hands). An all-time flop counter.
- **Markets**: picks, won, priced %.
- **This week's board**: flops, wins, "hidden on the public board".

## 10. App QR

The platform-level "Scan to play FlopMe" QR for installing the app.
