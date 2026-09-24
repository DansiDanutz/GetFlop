# 06 · Player Experience

The same player app serves clubs (Points), tournaments (TC) and the Arena (Stars). The **unit** switches with the context: `pts`, `tc` or `star`. Amount formatting follows the unit, and prices always show as multipliers `×(odds+1)`.

## 1. Home (`#/clubs`)

- A club carousel ("Swipe to see your clubs · tap one to enter"). Each tile shows the club photo, name, and role badges (Owner, Member, Awaiting approval), plus:
  - "n coupons in play"
  - "You won +X" (wins while away)
  - a news dot
- A "Find / new" tile opens: find by Club ID (7 digits), scan the club QR, create a club.
- The Arena tile shows "Free game, no club needed" and my Stars.
- Invite banner, QR-join banner, join-request status banners, club notices.
- Empty state: "not a member of any club yet — find one by its Club ID, or ask the floor for it".
- The list refreshes every 60 s while visible and on focus.
- Selecting a club sends `POST /clubs/select` and opens the preferred surface (last used, or the inspector surface while setup is incomplete).

## 2. Club lobby / club home (`#/player`)

- Top bar: identity button (club avatar, name, roles subtitle) and balance chip (tap to open the Points sheet).
- **Tiles** for everything the club plays: Ring Games, Tournaments, Arena. The rail has cards per table:
  - **Ring Game card**: photo or a drawn felt, name, game on the felt ("Texas Hold'em on the felt" / "Pot-Limit Omaha on the felt"), Featured badge.
  - State: "Playing now · #n", "Between hands", "No dealer".
  - Dealer name, "Per pick from <min>".
  - Buttons: **Sit down** / **See the table**.
- **Tournament card**: running / registration open, "n hands · your picks in TC", starts in, entrants. Buttons: **Register · <cost>** / **You're in** / **To your table** / **See the tournament**. Pinned tournaments appear first.
- "Nothing is playing right now". "All tables (n)".
- A paused club (billing) shows "This game is temporarily unavailable. The club will let you know when it reopens."
- Photo message cards from the club appear once as a full-screen card on entry (08 §6).

## 3. Joining a table

- `POST /player/table/:id/join` returns the table object:
  - `id, name, kind, status, betTypes[]` with `payout_odds, maxStakeCents, slug, category`
  - `minBetCents, maxBetCents, maxCouponCommitmentCents, maxCouponRounds, couponsEnabled`
  - `canPlay, playBlockedBy ("staff"|"watch"), isDealingHere`
  - current hand, active tournament, join code
- The client emits `join-table(tableId, {as:"player"})`.
- **Up to 4 games open at once**. Opening a 5th shows "You have 4 games open — close one before opening another. Anything already riding keeps playing."
- **Table QR entry** (`#/join/<code>`):
  - `GET /tables/:joinCode/info` returns `{id, name, kind, status, activeHandStatus, activeHandNumber, club}`. The client stores `pending_table_join {id, name, code, club}` in session storage. States: verifying, invalid code, "access denied or expired" (invalid, expired, or table closed), "Dealing now", late registration open or closed (tournament tables), "TAKE A SEAT", "Wrong table? Browse the lobby".
  - Not logged in: the pending join is stored, login is required, then the user continues.
  - Not a member: a join request is offered.

## 4. Table view ("play")

### 4.1 My games strip

A horizontal list of open games (max 4 visible), ordered by: current table first, then urgent participation, then pending wins. Each chip shows:

- The state: Picks open / "Hand n/of" (tournament) / No more picks / Result / Waiting / Table closed / Starting soon (in n min, at time).
- "n riding".
- "You won — tap to see".
- Participation urgency: "Play within n flops" / "Play now — 1 flop left".

`GET /player/my-games` returns this list with `state, handNumber, liveCoupons, committedCents, tournament info, participation, urgency`.

### 4.2 Stage

- Hand state header: "Picks open" / "No more picks" / "Result" / "Hand cancelled" / "Waiting for the dealer" / "The dealer is preparing the next hand".
- Notes: "Your coupons already played" (closed), "No flop used — single picks refunded" (cancelled).
- The flop area shows three cards as they come. "Three cards, once per hand".
- "Riding" shows the coupons riding on this table, or "No coupons riding".
- A NO MORE PICKS overlay with a countdown when the server sends one.
- Collapsible ("Show the table" / "Hide the table").
- Connection banner: Reconnecting (attempt n) / Disconnected.

### 4.3 Market picker

- Filter tabs: Popular, Pairs, Flushes, Colors, Straights, Specials, All (see 01 §2.3), sorted by price.
- Each market tile shows the name, `×multiplier`, and a mini example. Tapping adds it to or removes it from the slip.
- Coach mark: "Tap as many as you like."
- If play is blocked, the slip explains why:
  - staff: "Staff of this club do not play in it; only the owner can; use a separate player account"
  - watch-only
  - "You are dealing this table"

### 4.4 Coupon slip

Tabs: **COUPON** / **LIVE**.

- The rail when collapsed shows "n picks · tap to place".
- Picks list: each with an amount per flop (editable). "Clear all picks" empties the slip.
- **Amount per pick, per flop**:
  - A shared stepper and quick chips, **MAX**, **OK**.
  - Typing replaces the amount ("typing replaces the amount"; empty keeps the last one).
  - Limits line: "Min x · Max y per pick, per flop" (or "Min x" in the Arena).
  - The per-market cap is applied per pick.
- **How many flops?**: presets and −/+ up to the table max ("Maximum n rounds on this table").
- Totals:
  - **TOTAL COMMITMENT** with the math "a per flop × n flops" (mixed amounts show the per-flop total).
  - "Top win X · ≈m min at this table's pace" (m = rounds × 2.2).
- Validation messages (in priority order): server error text from the last attempt; staff / watch / dealer block; "amount must be between min and max per pick"; "Total commitment is over the X limit for one coupon"; "Insufficient balance".
- **PLACE COUPON <total>**. The first time, a confirm: "<math> = <total>. Locked once placed — no cancel." with **Place coupon** / **Go back**.
- On success:
  - a short haptic buzz
  - toast "Coupon placed · <total> · n flops · balance <x>"
  - the slip resets (rounds back to the default)
  - live coupons refresh
- On failure: the server error plus "Nothing was charged."
- Explainer line: "Pick outcomes, then set the amount and how many flops to play them on."
- Warning line: "Once placed, a coupon cannot be cancelled. If the table closes early, unresolved rounds are refunded automatically."
- **Tournament tables**: amounts in TC, min is the level minimum, **no maximum** (all-in allowed), ALL IN button, short-stack all-in banner "ALL-IN — waiting for the flop".

### 4.5 Live coupons

- `GET /player/coupons?status=live&tableId=` lists running coupons.
- Each shows its picks, "flop k / n", Committed, Won so far, "n flops still to come", and "See all n flops" (draws sheet).
- **Draws sheet** (`GET /player/coupon/:id/draws`): per flop the cards, won/lost per pick, In play, Cancelled with its explanation, and "Tap a flop to see it".

### 4.6 Results and win screen

- On `hand:settled`:
  - The player's bets for the hand are marked won or lost.
  - If any won, a **win screen** shows "YOU WIN" / "YOU WON", the flop, the winning markets highlighted, the per-pick payout, and the net for this hand. A win sound plays (two variants A/B) if sound is on.
  - If none won and the player is not on the table view: the toast "Net result: −X".
  - About 7 s later the place-and-balance bar refreshes and may animate a rank-up.
- **Background tables**:
  - Events for other open tables mark them "stale" and store a pending win.
  - Returning after ≥10 minutes hidden or disconnected triggers `GET /player/tables/latest-settled?ids=…` to catch up on wins that happened while away.
  - The pending win is shown when the player switches to that table.
- "Picks closed on T — your picks there were not played" (unsent slip picks when the window closed) (inferred).
- `coupon:completed`: toast "Coupon finished: +/−X". `coupon:voided`: "Coupon voided — refunded X (n rounds)". `coupon:leg-cancelled`: "A selection was cancelled — refunded X". `hand:cancelled`: "Hand cancelled. Picks refunded."

### 4.7 Place-and-balance bar (club and Arena)

It shows the table switcher, my board rank (with movement), my balance, and a pending request. Taps:

- table: switch table sheet
- rank: board
- balance: Points sheet (club) or Stars shop (Arena)

### 4.8 Heat board

Opens from the table (see 01 §8).

### 4.9 Tournament additions

- Tournament bar: Level, Minimum, Hand n/of.
- VPIP meter: "YOUR VPIP" compared with "VPIP REQ", with messages like "You need r of e — m more from k left", "You can sit out s more", "Getting tight", "LAST CHANCE", "Out".
- Standings tab (10 §8).
- Rebuy prompt when out of chips and rebuy is open.
- Out screens: out of chips / participation rule / generic, with "See where you finished".

## 5. Points sheet (club balance)

- Balance in the club, "Riding now".
- Toggle: **Request Points** / **Return to club**.
- Amount input (digits, `.` or `,`). "All" is offered for returns. Guidance lines: "Type how many Points you want" / "you have n — type up to that".
- Send: "Send request · X". A pending request is shown. See 04 §6.

## 6. History (`#/player` → History)

`GET /player/history?limit=30` → `{coupons[], bets[] (single picks), transactions[]}`.

- Segments: **Coupons** (Running / Finished / Voided, with draws), **Single picks (historic)**, **Points** (requests, returns, sends, claims).
- Summary: Committed, Points you won, Net today. "RIDING NOW" and "SETTLED" groups.
- "Play again" on a coupon (01 §5.6).

## 7. Profile

`GET /player/profile` → `{balanceCents, totalWageredCents, totalWonCents, profitCents, totalHands, winRate, memberSince, …}`.

- Net result, Points you played, Points you won, total hands.
- Points requests (pending and recent), with "Nothing pending".
- Rules & multipliers, medals and badges, "My code", language, sound toggle, "Member since YEAR".

## 8. Rules & multipliers screen

Every market grouped (01 §2.3), with its multiplier, its win rule in plain words, and 1–2 example flops. Then "How a coupon works", six points:

1. Amount per pick per flop; the total is shown first.
2. It cannot be cancelled.
3. Multipliers are fixed at placement.
4. A cancelled hand uses no flop.
5. Table close refunds unplayed flops.
6. Tournament participation may apply.

## 9. Medals and badges

- Club medals (03 §11) and Arena badges (11 §6).
- Each shows earned or "Not yet", and "Next badge" progress ("n more flops / in a row / days / markets / tables / weeks", "your best: x").

## 10. Messages inbox

- `GET /messages` returns messages to me from my clubs (announcements, direct messages, account and Points notices). Unread count. `POST /messages/read-all`.
- A message may carry a button ("Join <table>" / "Register: <tournament>"). Tapping sends `POST /messages/:id/tap` and navigates. If the target is gone: "No longer available".
- Photo messages: "See the photo" (`GET /messages/:id/photo`). If the photo was removed: "This message no longer has its photo".
- Per-club switch "Messages from <club>" On/Off: `PUT /messages/prefs {promoMuted}`. Off stops announcements only. Direct and Points messages always arrive.
- Photo cards: `GET /messages/cards` (pending full-screen cards). `POST /messages/:id/card-shown` after display.
- Socket `message:new` increments the badge.

## 11. Tournaments for players

The lobby filters are All / Upcoming / Late Reg / Running / Finished, and Any buy-in / Free / Paid. Detail, register, unregister, rebuy and add-on are covered in 10-tournaments.md.

## 12. Install / PWA

- Manifest and service worker (installable).
- Android and Chromium: a custom prompt "Install FlopMe — add to your home screen", with Install / Not now. "Not now" is remembered per device.
- iOS Safari: a 3-step guide (tap Share, choose "Add to Home Screen", launch).
- The app reports `pwa: true` at login when running standalone.
- App QR (staff/dealer screens and admin): "Scan to play FlopMe", which opens the app URL for install.

## 13. Sounds and haptics

A sound on/off toggle. Win sounds (two samples) and short tones. Haptic feedback on coupon placement where supported.

## 14. First-run tours

- **Hello tour** (the first time the app opens, replayable as "Getting to know FlopMe"). Dealer-mascot slides:
  1. Welcome: predict the flop from your phone.
  2. Get into your club: show My code or scan the club QR.
  3. Club Points, and a free Arena with Stars.
  4. We are here: contact via Telegram or email.
  - Buttons: Skip / Next / Let's go.
- **Intro sheet** "How FlopMe works" (before the first coupon), 4 cards:
  1. You guess the flop.
  2. A coupon plays itself out.
  3. The amount multiplies: per pick, per flop.
  4. A coupon cannot be cancelled.
  - Button: "Got it". There is an Arena variant of the copy.
- **Welcome per role** (once per club and role; `GET /clubs/onboarding` gives the scenarios already seen, `POST /clubs/onboarding/seen {code, scenario}` records one):
  - player: "Welcome to the table"
  - dealer
  - inspector: "Whatever needs you comes first"
  - manager
  - owner: "Your club sets up in n steps" or "Your club is ready"
- **Coach marks** (codes `hint.*`), each shown once:
  - player: markets, then coupon button, then identity
  - dealer: sit, then console, then identity
  - inspector: requests, members, identity
  - manager: next step, members, identity
  - owner: next step, diamonds chip, identity
  - Buttons: Next / Skip / Got it, with "n of total". "Show me around again" restarts them.
- Help: "?" per screen, help index, support contact (Telegram / email), "Need help?" on login.

## 15. Slogans and marketing strings

The login screen rotates short taglines (12 in the source). GetFlop must write its own set.
