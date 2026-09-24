# 04 · Points, Supply & Ledger

Points are the club-internal play currency. They are **free**: never sold and never converted to Diamonds or money. Each club's Points are separate. The platform never adds Points across clubs.

Units: integer milli-Points (1 PT = 1000). Any amount typed by staff or players must be above 0 with at most 2 decimals (`points.amount_invalid`).

## 1. Balances (per club)

| Holder | Meaning |
|---|---|
| **Club pool** (treasury) | Minted Points not yet handed out, plus Points returned or claimed back, plus everything the club won from play (inferred: game results accrue to the pool) |
| **Inspector stock** | Points an inspector holds for handing out. It is a sub-balance moved from and to the pool |
| **Player wallet** | One per member per club. Used for coupons and tournament entries |
| **Riding** | Points committed to live coupons, not yet resolved. Shown as "Riding now" / "Still riding on live coupons". Not part of the wallet |
| **Reserved for tournament guarantees** | Pool Points earmarked to cover guaranteed prize pools (shown on the Points screen) (inferred: GTD amount minus collected, per upcoming or running tournament) |

## 2. Supply equation ("How it adds up")

`GET /clubs/:id/points` (owner or manager; others get `points.forbidden`) returns:

- `pool` (free to send), `inStocks` (held by inspectors), `inWallets` (players), `issued` (total minted to the club, including an **opening balance** equal to what players already held when the record began, with its own note), `gameMinted` ("won in games"), `gameBurned` ("played in games"), reserved for tournaments, and the check result.
- **Invariant**: `pool + inStocks + inWallets (+ riding) = issued + gameMinted − gameBurned` (inferred exact form; the UI copy is "what the club holds and what the players hold match what was issued and played").
  - When it holds: "Everything adds up".
  - Otherwise: "Off by N: a movement did not go through the club's Points record. Nothing was changed — tell FlopMe". The check never auto-corrects.
- **Negative pool**: legacy clubs that sent Points before minting was required may show "The pool is N below zero". The owner can mint exactly N with the preset reason "Bring the pool back to 0".

## 3. Mint

`POST /clubs/:id/points/mint {amount, reason}` with an `Idempotency-Key` header.

- Owner only (`points.mint_owner_only`). A reason is required (`points.reason_required`) and is recorded with the owner's name.
- Adds to the pool. **Nothing can leave the pool beyond what was minted.**
- Preset reasons are offered when minting from a shortfall prompt: "For Send Out to <name>", "For stock to <name>", "Bring the pool back to 0".
- Minting is free (the platform catalogue has a legacy "Point inventory rate" kind for charging Diamonds per Point; currently unused, see 12).

## 4. Send Out / Claim Back (staff → member)

From the member card. Endpoint `POST /inspector/player/:userId/{load|withdraw} {amountCents, note?}`.

- `load` = **Send Out**: Points into the member's wallet.
- `withdraw` = **Claim Back**: Points from the wallet back to the club.
- **Source**:
  - Owner or manager: the club pool.
  - Inspector: their own **stock**. Send Out takes from the stock, and Claim Back goes back into the stock.
- Shortfalls:
  - Pool short: owner sees `points.pool_short_owner {pool, needed}` with a "Mint Points" button. Others see `points.pool_short` and the owner gets a notice.
  - Inspector stock short: `points.stock_short {stock, needed}`, and the owner is told (notice `points_stock_short`).
- Claim Back cannot exceed the member's balance ("Whole balance · n" chip) (inferred error: invalid amount).
- The optional note is visible to staff only and has a maximum length (`points.note_too_long {n}`).
- Quick-amount chips are shown (1, 2, 5, 10, 20, 50, 100 … scaled to the balance; inferred from the chip generator).
- Receipt sheet: SENT OUT / CLAIMED BACK, the amount, and the new balance.
- Ledger types: `deposit` (Send Out), `withdrawal` (Claim Back), each with the actor and the source (pool or stock).
- Emits `balance:updated` to the member, and `live:changed` / `floor:changed` to staff.

## 5. Inspector stock

`POST /clubs/:id/members/:userId/stock {direction: "give"|"take", amount, note?}`

- Only an owner or manager gives or takes stock (`points.stock_forbidden`). The target must be an inspector (`points.stock_not_inspector`).
- Give moves pool → stock (pool must cover it). Take moves stock → pool, up to what is held (`points.stock_take_more_than_held {stock, asked}`). Failure: `points.stock_failed`.
- The inspector card shows two figures:
  - "Balance: for playing at the tables". Note that inspectors cannot play in their own club.
  - "Inspector stock: for sending to players, given by the owner or a manager".
- The Requests tab shows the approver's own stock ("Points requests you approve come out of it").
- Receipts: "Stock given" / "Stock taken back".

## 6. Player Points requests

- **Request Points** (reload / load): `POST /player/reload-request {amountCents}`. "Adds Points to your balance after approval."
- **Return to club** (cashout / return): `POST /player/cashout-request {amountCents}`, where `amountCents ≤ balance`. An "All" chip is offered. With a balance of 0: "nothing to return".
- `GET /player/requests` → `{reloads[], cashouts[]}` with status `pending|approved|rejected`. The UI shows a waiting request ("A request for X is waiting for the club").
- The player's sheet shows the balance in the club, "Riding now", mode toggle (ask / return), amount, and a one-line explanation of each side.
- The request goes to that club's staff. On approval Points appear in the wallet. A running coupon is unaffected.

### 6.1 Staff handling

- `GET /inspector/requests` → `{reloads[], cashouts[], dealerSits[], myStock}`. Items have `id, user_id, username, display_name, amount_cents, balance_cents, status, created_at`.
- Pending list groups: **Points in** (requests), **Points out** (returns), **Join requests**, **Dealer seat requests**. The oldest are shown first.
- **Approve**: `POST /inspector/request/:id/approve {}`.
  - The confirm says "This moves Points now and cannot be undone".
  - The approver's source (pool or own stock) must cover a load. For a return, a warning appears if the balance no longer covers it ("Balance will not cover this").
  - Ledger `reload` (request approved) / `cashout` (return approved), with the approver.
- **Reject**: `POST /inspector/request/:id/reject {reason?}`. The reason is optional (for example "Identity not confirmed").
- The player gets `request:actioned {type, status}` plus a receipt notice: "Points request approved/declined", "Points return approved/declined".
- Staff get `request:new` and `request:resolved {byUserId}`. Other staff screens refresh, except the one that acted.
- History: `GET /inspector/requests/history?days=30`. Answered items, newest first, with status (Approved / Rejected / Waiting) and type (Points request, Return to club, Join request, Dealer seat · table).

## 7. Immutable ledger

Every movement is an append-only row. No row is updated or deleted, and corrections are new rows.

| Type (API) | Staff label | Player label | Sign (wallet) |
|---|---|---|---|
| `deposit` | Sent out | Send Out / Points received | + |
| `reload` | Request approved | Send Out | + |
| `withdrawal` | Claimed back | Claim Back | − |
| `cashout` | Return approved | Claim Back / Points returned | − |
| `coupon_placed` | Coupon bought | Coupon | − (commitment) |
| `bet_placed` | Pick | — | 0 (round materialized) (inferred) |
| `bet_won` | Win | Win | + payout |
| `bet_lost` | — | Losing pick | 0 (informational) |
| `bet_refunded` | Pick voided | Points returned | + |
| `coupon_voided` | Coupon voided | Coupon voided | + refund of unplayed rounds |
| `coupon_leg_cancelled` | Coupon pick cancelled | Coupon flop cancelled | + refund |
| `membership_ended` | Left the club | Membership ended | − whole balance (to pool) |
| `tournament_buyin` / `_rebuy` / `_addon` | Tournament buy-in/rebuy/add-on | same | − |
| `tournament_refund` | Tournament refund | same | + |
| `tournament_payout` | Tournament prize | same | + |
| `sim_reset` | Simulation reset | same | ± (simulation club only) |

Each row stores: club, user, type, signed amount, balance after, actor (staff, player or system), related ids (coupon, bet, hand, request, tournament), note, created_at. The pool and stocks have their own ledgers (mint, stock give/take, request approvals) with the same properties.

## 8. Member card figures (staff view)

`GET /clubs/:id/members/:userId?dateStart&dateEnd&tz`:

- Header: name, @username, roles, play mode, member since, balance, and stock for inspectors.
- **In this club** (period: All time / 7 days, and more): Hands, Played, Won, Result (Played − Won from the club's view, inferred sign), Sent Out, Claimed Back. Ring Game Points only. Tournament chips are not counted.
- **Where they play**: per market, settled picks, Points played, actual hit rate compared with expected.
- **Coupons**: paginated (`GET /clubs/:id/members/:userId/coupons?offset=`, then `.../coupons/:couponId`). Each shows table, picks (×odds, amount per flop), `d/n flops`, still in play, and flop-by-flop results, with cancelled legs marked.
- **Latest movements**: ledger rows with actor "by <name>" / "by the player".
- **Management**: Send Out, Claim Back, Give/Take stock, roles, watch-only, remove from club, transfer ownership (owner viewing another member).

## 9. Balance check (drift)

`GET /inspector/wallet-drift` → `{checked, driftingCount, worstDriftCents}`.

- For every player wallet, the check compares the stored balance with the sum of ledger rows.
- The floor shows a danger row "Balance check — n player balances do not add up · largest X" when `driftingCount > 0`.
- If the check itself fails: "Could not run — unknown, not a sign that all is well".
- Analytics shows "All n player balances add up" or "n of total do not add up (largest …) — nothing was changed, tell FlopMe".

## 10. Points in reports (definitions)

- **Points played / Handle**: Σ stakes of Ring Game picks whose flop settled in the period.
- **Won by players / Paid**: Σ payouts of those picks.
- **Club result / Hold / GGR**: played − paid. **Hold %** = result / played.
- **Theoretical hold** for a market: `1 − (odds+1) × probability`, weighted by Points played.
- **Put into coupons**: Σ commitments at purchase time. **Refunded**: voids, cancels and refunds.
- **Players hold now / The club holds now**: wallet sum and pool (+ stocks).
- **Still riding on live coupons**: Σ unresolved commitments right now.
- Tournament chips (TC) are never included in Points figures. Tournament entries (buy-ins, rebuys, add-ons, fees) and prizes are Points and are reported separately. They belong to the club, not to a table.
