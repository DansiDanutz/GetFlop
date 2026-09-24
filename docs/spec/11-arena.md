# 11 · Arena (public free table with Stars)

The Arena is a platform-run, public GetFlop area outside every club. It is dealt automatically, and anyone who registers can play at once with **Stars (★)**. Its purpose is acquisition: people learn the game before they reach a club.

## 1. Principles

- **Stars are never money.** They cannot be cashed out, converted, or sent to anyone. Buying Stars buys playing time, never a place on the board.
- The Arena is excluded from every club figure and every commercial Diamond figure. It is reported only on the admin "FlopMe Arena" page.
- Your club, your Points and your display name are never shown in the Arena. The public board shows usernames only, and can be hidden.
- It is modelled as a special club of `kind = "arena"`. The unit is `star`. Every table is auto-dealt with a random flop from a fresh shuffle.

## 2. Entering

- Home tile "Arena · Free game, no club needed · You have n ★". The club lobby also has an Arena tile ("Free · outside the club").
- `GET /arena/summary` → `{open, stars, …}`. When closed: `arena.closed`.
- `POST /arena/enter {}`:
  - Creates the Arena membership and wallet on first entry, with the initial grant (inferred **2,000 ★**, matching the refill target).
  - Claims a due free refill.
  - Errors: `arena.enter_failed`, `arena.unavailable`, `arena.not_a_club` (Arena-only action attempted elsewhere).
- Tables (`GET /player/tables` in the Arena context) carry a `dealClock {phase, windowMs, remainingMs}` and `dealSeconds`.
  - Card states: "Dealing now" with "Next flop in seconds" and a live ring; "Asleep", "sleeping · wakes when you sit".
  - "FlopMe deals here · every n″" / "Deals the moment you sit down".
  - A table **sleeps** when nobody is seated and **wakes when a player sits** (inferred: starts a hand immediately on the first join).
- The dealer mascot copy says FlopMe deals (not a person). "Choose for the next flop — it is dealt in a moment". Empty state: "The table is being made ready — tap Refresh".

## 3. Play rules (differences from clubs)

- Same markets and multipliers as clubs (01), unless the admin sets otherwise.
- Min per pick = table min. **No maximum per pick** other than the balance, **no coupon cap**, and no per-market automatic limit.
- Coupons work the same way (rounds ≤ table max, default 20).
- Auto-deal cycle per table: open picks for the window, close, random flop, settle, next. The interval is a server parameter (for example the "every n″" shown on the card).
- No Points requests: "There is nothing to ask for here".

## 4. Free refill

- When the balance **drops under 500 ★**, a free refill **back to 2,000 ★** becomes available, **at most once every 24 hours**.
- The bar and shop show: "Your free refill is ready: n" with a **Take it** button (sends `POST /arena/enter`), "Next free refill of n: in <t>", and "A free refill of n comes whenever you drop under 500 ★".
- Admin figures track Stars **granted**, **refilled** and **bought**.

## 5. Weekly leaderboard ("The board")

- `GET /arena/board?period=week|all` → `{period, weekOf, closesAt, podium, top[{rank, username|hidden, flops, net, me}], me{rank,…}, meHidden, biggestHit{username, multiplier, stars}}`.
- Ranking metric: **net ★** for the week (inferred tie-break: more flops ranks higher). The flop count is shown too.
- Tabs: This week / All time. Header tile: "net · closes in <t>". A podium for the top 3. Cut lines at "Top 3 · a badge" and "Top 10 · a badge". "Biggest hit of the week".
- Empty states: "Nobody has played yet this week — the first flop you play puts you on the board". "The board is new — you are the first one on it."
- "Play a flop and you are on the board" (`arena.not_played` for actions needing a played flop).
- **Hide my name**: `POST /arena/board-visibility {hidden}`. Hidden players show as "Player" and keep their place.
- Public notice: everyone in the Arena sees your username, flops and net ★.
- The week closes weekly (inferred Monday 00:00 platform time). Weekly badges are awarded at close.
- The place and balance bar on the Arena table shows rank (tap for the board) and Stars (tap for the shop).

## 6. Badges

`GET /arena/medals` → earned or locked, with progress. `arena:badges {badges[]}` is pushed on earn ("Badge earned: <name>" / "n badges earned", shown after any win screen).

| Code | Name | How to earn |
|---|---|---|
| `first_flop` | First flop | Play your first flop |
| `flops_10` / `flops_100` / `flops_1000` | 10 / 100 / 1,000 flops | Play that many flops |
| `hit_x170` | The long shot | Win a market at ×170 |
| `hit_x40` | A big one | Win a market at ×40 or more |
| `three_in_a_row` | Three in a row | Win three flops in a row |
| `every_market` | Every market played | Play every market at least once |
| `week_streak` | Seven days running | Play on seven days in a row |
| `comeback` | The comeback | Fall under 100 ★ and climb back over 5,000 ★ in the same week |
| `ten_markets_won` | Ten markets won | Win on ten different markets |
| `week_top10` / `week_top3` / `week_first` | Top 10 / Top 3 / First of a week | Finish a week in that range |

Titles: "Champion of the week", "Veteran", "Sharpshooter" (display titles, inferred: shown on the board for the week winner, high flop counts and high hit rates).

Badge groups in the UI: Flops, Big moments, Exploring, Coming back, The week. "Next badge" progress: n more flops / n more in a row / n more days / n more markets / n more weeks, with "your best: x".

## 7. Stars shop

- `GET /arena/packs` → `{open, packs[{id, stars, priceCents, bonusPct?, available, unavailableReason}], capDayCents, capMonthCents, …}`.
  - Closed: "The shop is not open yet" / `arena.shop_closed`. Card payments not live: "Card payments are not available yet".
- Pack prices are shown "+ VAT · the final amount is calculated at checkout".
- **Spending caps**: at most `capDay` per day (resets 00:00) and `capMonth` per month (server parameters, in euro cents). Messages: "{left} of today's {cap} is left", with the same for the month. Errors `arena.cap_day`, `arena.cap_month`.
- A required consent checkbox: deliver immediately, and lose the withdrawal right for Stars already played ("Tick the box first").
- `POST /arena/checkout {packId, consent:true, locale}` → `{url, orderId}` (Stripe Checkout). The browser is redirected there. Only one open checkout at a time (`arena.checkout_open`). Unknown pack: `arena.unknown_pack`.
- Return URL `#/player?stars=success|cancel&order=<id>`:
  - success: "n ★ added. Thank you." (credited by webhook).
  - cancel: `POST /arena/orders/:id/cancel`, "Nothing was charged". Errors `arena.unknown_order`, `arena.cancel_failed`.
- Arena sales are a separate product from Diamonds (separate revenue report, VAT inside the price for reporting).

## 8. Retention

- Arena hands are **deleted after N days** (server parameter). Admin figures for hands, played, paid and hold are clamped to that window. An all-time flop counter survives deletion.

## 9. Admin report

See 13 §9.
