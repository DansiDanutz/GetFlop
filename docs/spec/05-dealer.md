# 05 · Dealer

The dealer surface is how the physical flop enters the system. It must be fast: the target is about **10 seconds of dealer time per hand** (the tour page gives under 1 s for "new hand", under 1 s for "no more picks", and 5–7 s to enter three cards and confirm).

## 1. Who can deal

- Any member with the **Dealer** role in the club. The owner or a manager can give themselves the dealer role ("I'll deal myself") and deal too.
- A dealer deals **one table at a time, across all clubs**. They can hold the dealer role in several clubs but can only be seated at one table overall.
- A dealer **cannot play on the table they deal** (`coupon.dealer_own_table`). Staff other than the owner cannot play in the club at all.
- Auto-deal tables (Arena, auto-deal tournaments, simulation) do not take a dealer (`dealer.auto_table`).

## 2. Seating

### 2.1 Endpoints

- `GET /dealer/tables` returns the tables the dealer is seated at or assigned to (normally 0 or 1) with the current hand status.
- `GET /dealer/available-tables` → `{tables[], needsApproval, pending}`. These are open tables in the active club with no dealer, plus `needsApproval` (the club's dealer-sit-approval setting) and my pending sit request.
- `POST /dealer/table/:id/sit`:
  - No approval required (or the caller is owner or manager): seats immediately. Toast "You are seated — the table is yours".
  - Approval required: creates a **sit request** ("Asked to sit at T — waiting for approval"). Floor staff see it in Requests. Only one pending request is allowed (`dealer.request_pending`).
- `POST /dealer/sit-requests/:id/cancel` withdraws a pending request.
- `POST /dealer/table/:id/leave` **stands up**. The table stays open without a dealer until someone sits or the floor assigns one. Blocked while a hand is live (`dealer.hand_live {hand}`).
- `POST /dealer/table/:id/switch {heldTableId}`: when the dealer is seated elsewhere (possibly in another club), stand up there and sit (or ask to sit) here in one step. Stale state gives `dealer.switch_stale`.
- `POST /dealer/held/leave` stands up from the held table in another club, from here. It returns `{table, club}`.

### 2.2 Conflicts and errors

| Code | Meaning |
|---|---|
| `dealer.table_taken` | Table closed or already has a dealer |
| `dealer.holds_other` | Already dealing another table: stand up first |
| `dealer.you_deal_elsewhere {table, club}` | Seated at a table in another club |
| `dealer.held_hand_live {table, club}` | A hand is live at the held table: finish it there first |
| `dealer.busy_elsewhere` | (for staff assigning) this dealer is at another table |
| `dealer.not_dealing` | Hand action by someone not seated at this table |
| `dealer.own_live_coupons {n, table}` | The dealer has live coupons on the table they want to deal. They must wait for them to finish or deal another table |
| `dealer.table_changed` | The table changed meanwhile |
| `dealer.not_found` | Assignee is not a dealer of this club |

Conflict UX: when sitting while seated elsewhere, the dialog asks "You are dealing T (C). Leave it?" with "Yes, sit here" / "Yes, ask here". If that table has a live hand: "Finish it there first", with a "Go to T" button.

### 2.3 Approval and floor actions (staff side)

- `POST /inspector/dealer-sit/:sitId/{approve|reject}`. If the table got a dealer meanwhile, the request closes with "already has a dealer". If the dealer went to another table, it closes with "dealing at another table right now".
- `POST /inspector/table/:id/assign {dealerId}` (floor puts a dealer on a table) and `POST /inspector/table/:id/unseat` (stand the dealer up; the dealer's screen is told immediately). Assigning a dealer who is seated elsewhere triggers the same "leave there" flow for staff (inferred) or `dealer.busy_elsewhere`.
- Opening a table with a dealer: `PUT /inspector/table/:id/open {dealerId}` (see 07).

### 2.4 Dealer notifications

- Socket `dealer:seat {status, tableId, tableName}`:
  - `approved`: "Approved — you are seated at T". The console opens.
  - `assigned`: "The floor put you on T".
  - `rejected`: "your request was declined".
  - `taken`: "T already has a dealer — your request was closed".
  - `unseated`: "The floor stood you up from T".
- `GET /dealer/notices` and `POST /dealer/notices/:id/read`: persistent notices, for example `dealer.wanted_elsewhere`: "<who> wants you to deal, but you are still seated at T (C). Stand up there first."
- Socket `notice:new {code, params}` shows a localized warning toast `notice_<code>`.

## 3. Table list screen

- Header: club identity button, App QR, help, menu.
- "My tables": the table I'm seated at (open console), with status badges (Open / Closed / Picks open / Dealing) and "Hand #n".
- "Available tables — sit to deal": each open table without a dealer, with "Sit here" or "Ask to sit here".
- Tournament tables are flagged "Starts soon" / "Tournament live".
- Pending request panel: "Waiting for approval to sit at T…", "The floor staff see your request in their Requests", Cancel.
- "Stand up from T (C)" panel when held in another club.
- Empty state: "You are not dealing any table — pick one below".
- The coach mark on first visit points at the sit button.

## 4. Console

### 4.1 Layout

- Header: table name, hand number badge, picks status badge, countdown ring (if the server gave `bettingTimerSeconds`; it turns urgent at ≤5 s).
- Live strip while picks are open: "Players: p · Picks: b", or "No picks yet". It refreshes on `coupon:placed`.
- Flop area: the three cards of the current or last hand.
- **Recent hands** (`GET /dealer/table/:id/hands?limit=20`): number, flop, "Picks: n", "won X" / "no winners" / "cancelled", status, and the amount played. Tournament amounts are shown in TC.
- Fixed bottom action zone. Buttons are large and always in the same place:
  - Idle, settled or no hand: **NEW HAND**.
  - `betting_open`: players/picks info, **NO MORE PICKS**, **CANCEL**.
  - `betting_closed`: **ENTER FLOP** (opens the picker; it opens automatically when picks close), **CANCEL**.
  - Auto-dealt: "Next hand starting automatically…" instead of NEW HAND.
- Dealer menu (☰):
  - Back to my tables (stay seated)
  - Stand up (the table stays open without a dealer)
  - Show table QR (players join this table)
  - App QR (install the app)
  - Card entry layout (Auto / Always compact / Always full)
- Current state is refreshed via `GET /dealer/table/:id/current-hand` on load or reconnect.

### 4.2 Hand flow

1. **NEW HAND**: `POST /dealer/table/:id/start-hand`. Response `{hand, bettingTimerSeconds?}`.
2. **NO MORE PICKS**: `POST /dealer/table/:id/no-more-bets`. The UI shows "Closing picks…". The server emits `hand:no-more-bets` then `hand:betting-closed`.
3. **ENTER FLOP**: the card picker (§5). **Confirm flop** opens a review modal with the three cards large, "Players will see exactly these cards. Settlement is final.", and **Go back** / **Confirm & settle**. Confirm sends `POST /dealer/table/:id/enter-flop {card1, card2, card3}`.
4. Settled: the console shows the result and the hand appears in recent hands. NEW HAND is available again.
5. **CANCEL** (while open or closed): confirm "Every pick on this hand is refunded to the players", then `POST /dealer/table/:id/cancel-hand`.

## 5. Flop picker

- Title: "Select the flop (n/3)". Header buttons: layout toggle, **Scan**, **Cancel**.
- Card codes are `<rank><suit>` (T shown as "10"). Suits: ♠ spades, ♥ hearts (red), ♦ diamonds (red), ♣ clubs.
- **Duplicate guard**: choosing a card already in the flop shows "That card is already in the flop" and does nothing.
- **Layout modes** are stored per device:
  - `auto` (default): compact when the viewport is ≤ 640 px wide, or ≤ 500 px high with a coarse pointer. Otherwise full.
  - `compact` / `full`: forced.
  - The toggle cycles auto → (the opposite of what auto would pick) → auto. The label shows "Auto · Compact/Full".
- **Compact mode** (phone), two taps per card:
  - Three slots. The active slot shows "Card n · choose the rank".
  - Rank grid `A K Q J 10 9 8 7 6 5 4 3 2`. After a rank: "Card n · choose the suit for <rank>" with 4 suit buttons. The pending slot shows `<rank>?`.
  - Tapping a filled slot edits it ("Change card n", "replacing <card>"). The next rank and suit replace that slot.
  - **Back**: cancel the pending rank, else leave edit mode, else remove the last card. **Clear** empties all.
  - When 3 cards are set: "Check all three cards before settlement" and **Confirm flop**.
- **Full mode** (tablet): a preview of the 3 cards (empty placeholders), Confirm (when 3 are chosen) or "Tap n more below", and a grid of all 52 cards by suit rows. Tapping toggles a card in or out (max 3).

## 6. Camera scan of the flop

- Available from the picker ("Scan") while the hand is `betting_closed` and no flop is stored.
- Opens the rear camera (ideal 1920×1080). Hint: "Frame all three cards face up, then capture". States: starting, ready ("hold steady with all three cards sharp"), denied ("allow the camera").
- Capture: downscale so the longest side is ≤ 1568 px and encode as JPEG quality 0.85. Then `POST /dealer/table/:id/scan-flop {image: <base64>, mediaType: "image/jpeg"}` → `{cards: [...up to 3 codes], confidence: "high"|"low"}`.
  - 3 cards, high confidence: "Cards read — check them and confirm".
  - 3 cards, lower confidence: "read with some doubt — check each one carefully".
  - Fewer than 3: "n of 3 cards recognised — tap the rest by hand".
- The recognized cards pre-fill the picker. **The dealer must still confirm.** Scanning never settles by itself.
- If the hand state changed during recognition, the result is discarded.
- Server implementation: an image-recognition model (vision LLM or a card detector) (inferred). It must return only valid, distinct card codes.

## 7. Real-time events the dealer listens to

`hand:started`, `hand:no-more-bets`, `hand:betting-closed`, `hand:settled`, `hand:cancelled`, `coupon:placed`, `dealer:seat`, `notice:new`. The dealer joins the table room with `join-table(tableId)`.

## 8. Welcome and coach marks

- The first time on the dealer surface: a welcome ("You deal from here — one table at a time; sit, run the hand, enter the flop as it came").
- Coach marks: the sit button, then the NEW HAND button.
