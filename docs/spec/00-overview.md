# GetFlop — Functional Specification · 00 Overview

Status: draft v1 (2026-09-24). This is a clean-room functional spec. It was written from the public tour page, the client UI dictionary (English), the client's REST/socket call sites, and client-side logic. It does **not** copy source code or UI text. Anything the client could not show directly is marked **(inferred)**.

Spec files:

| File | Scope |
|---|---|
| 00-overview.md | Product, glossary, roles, permission matrix, navigation map |
| 01-game-engine.md | Cards, markets, pricing, hand state machine, coupons, limits, heat board |
| 02-accounts-auth.md | Accounts, PIN, Google, email, terms, sessions, languages, deletion |
| 03-clubs-membership.md | Clubs, setup checklist, IDs, invites, QR, join requests, roles, rooms, deletion, hub, board, medals |
| 04-points-ledger.md | Points supply, pool, inspector stock, requests, ledger, drift checks |
| 05-dealer.md | Dealer console, seating, hand controls, flop picker, camera scan |
| 06-player.md | Player app screens and flows |
| 07-inspector-floor.md | Floor, tables, requests, reports, sessions, analytics, simulation |
| 08-owner-manager.md | Staff tabs, members, settings, club account, messages, posters |
| 09-tv.md | Room TV (Ring Game and Tournament) |
| 10-tournaments.md | Tournament wizard, lifecycle, participation, prizes |
| 11-arena.md | Public Arena with Stars |
| 12-billing-commerce.md | Diamonds, Club Levels, play charge, Stripe, VAT, receipts, promo codes, catalogue |
| 13-admin-platform.md | Platform admin |
| 14-api-and-realtime.md | REST endpoints and socket events |
| 15-error-codes.md | Every error code and its trigger |

---

## 1. Product summary

GetFlop lets people in a live poker club bet small, club-issued **Points** on what the **flop** (the first three community cards) of a real, dealer-dealt hand will contain. The club's own dealer deals normally. While the hand is being dealt, any club member (at the table, on the waiting list, knocked out of a tournament, or at home) opens the table on their phone and picks outcomes such as "three different suits", "a pair", or "contains an ace". The dealer enters the three flop cards on a phone, or photographs them, and every open pick is settled at once.

Core properties:

- **Real cards, not an RNG** for club tables. The dealer enters what physically came.
- **Points exist only inside one club.** They are not sold. The owner mints them for free and staff hand them out. They cannot be moved between clubs.
- **Coupons** let a player pick once and play the same picks automatically over N upcoming flops.
- **A fixed house margin per market.** Multipliers sit below the fair price. The club keeps the difference over the long run.
- **The platform earns Diamonds** (100 D = €1), which the club owner buys by card. There are only two charges: a Club Level subscription every 30 days, and a play charge of 1 D per Point played.
- Extra modules: club messaging channel, room TV display, promotional "FlopMe tournaments" (tournament chips), a public free **Arena** (Stars, auto-dealt), and a platform admin console.
- Languages: English (`en`) and Greek (`el`). The tour page also advertises Italian (`it`), but the app only has `en` and `el` (see open questions).
- Delivery: a mobile-first web app (PWA, installable), plus a TV display page. Hash-based routing on `app.<domain>`, a public club invite page at `/c/<ClubID>`, and legal pages at `/legal/<doc>.<lang>.html`.

Example economics from the tour page (illustrative only): one table, about 20 hands an hour, about 15 picks per hand, 2 Points average. That is 600 Points played per hour, and at a blended margin of about 12% the club keeps about 72 Points per hour.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Club** | A tenant: one venue with its own members, tables, Points and Diamonds. It has a public 7-digit **Club ID**. |
| **Room** | A grouping of tables inside a club. The current rule is one room per club. Older clubs may keep several. There is also a reserved "Simulation" room. |
| **Table / Ring Game** | A GetFlop table tied to a real cash-game table. Kind `cash` (UI label "Ring Game"). It has a name, a game on the felt (NLH / PLO / Other), an optional photo, allowed markets, limits, a join code and QR. There are no seats: any number of members can "open" it. |
| **Tournament table** | A table of kind `tournament`, owned by one GetFlop tournament. Picks there use tournament chips. |
| **Hand** | One dealt poker hand on a table. States: `pending` → `betting_open` → `betting_closed` → `settled`, or `cancelled`. It has a sequential `hand_number` per table. |
| **Flop** | The three cards entered for a hand. It is the only thing markets are settled on. Cards are written `<rank><suit>`: rank one of `2..9,T,J,Q,K,A`, suit one of `s,h,d,c` (for example `Ah`, `Td`). |
| **Market / bet type** | An outcome on the flop, such as `rainbow` or `any-pair`. It has a slug, a category, a probability, `payout_odds` (X:1) and an active flag. |
| **Multiplier** | The total return per unit staked on a win, equal to `payout_odds + 1`. Rainbow shows ×2.3, meaning odds of 1.3:1. |
| **Pick (selection / leg / bet)** | One market with an amount per flop. |
| **Coupon (slip)** | A set of one or more picks, each with its own amount per flop, played over `rounds` (1..max) consecutive flops of one table. It cannot be cancelled once placed. |
| **Round / draw** | One flop of a coupon. A coupon with R rounds and P picks makes P×R individual bets. |
| **Commitment** | The total a coupon debits when placed: Σ(amount per pick) × rounds. |
| **Points (PTS)** | The club-internal play currency. Internal unit is milli-Points (1 PT = 1000 units), and the UI allows at most 2 decimals. The API's `*Cents` fields are in these units. |
| **Pool (club treasury)** | The club's stock of minted Points that have not been handed out. |
| **Mint** | Owner-only creation of new Points into the pool, with a reason. |
| **Send Out / Claim Back** | Staff moving Points from the pool (or an inspector's stock) into a member's wallet, and back. |
| **Inspector stock** | Points held by an inspector for handing out, given and taken back by the owner or a manager. |
| **Points request** | A player asks for Points (a "load" / reload request) or returns Points (a "cashout" / return request). Staff approve or reject it. |
| **Diamonds (D)** | The platform billing currency. 100 D = €1. Bought by card by the owner, and valid 12 months (oldest spent first). |
| **Club Level** | A subscription tier (Starter … Club 5K) that sets capacity limits. It is charged every 30 days in Diamonds. |
| **Play charge** | 1 D per Point played on Ring Game picks, charged to the club after each hand. For tournaments only the buy-in counts. |
| **Free pilot** | A billing mode where charges are measured and shown as previews but not taken. |
| **TC (tournament chips)** | The chips used for picks in a tournament. They are not Points. |
| **Buy-in / fee / rebuy / add-on** | Tournament entry costs in Points. |
| **VPIP / participation** | The minimum share of a tournament's hands a player must have action in, or they are eliminated. |
| **Stars (★)** | The Arena-only currency. Free refills are available and packs can be bought. Stars are never money. |
| **Arena** | A public, platform-run, auto-dealt table outside every club. |
| **Heat board ("Hot & cold")** | A per-table display of how often each market hit in the last N flops compared with its own expected rate. |
| **Session / shift** | An analytics window opened and closed by the floor. It closes automatically at 06:00. |
| **Floor** | The inspector's live dashboard. |
| **Watch-only** | A per-member play mode: the member can see everything but cannot place coupons or enter tournaments. |
| **Player code** | A signed QR on the player's phone that rotates every minute. Staff scan it to find or admit the player. |
| **Join code** | A table's 4–16 character alphanumeric code used in table QR links (`#/join/<code>`). |
| **Display token** | The credential a TV uses to show one table or tournament. |
| **Live-big threshold** | The club setting that marks picks or wins at or above N Points as "big" in reports. |

---

## 3. Roles

### 3.1 Account-level

| Account type | Description |
|---|---|
| `player` | Every normal user. Club roles are granted per club. |
| `admin` (platform admin) | Runs the whole platform: all clubs, commerce, all accounts. It cannot be deleted from the app. |
| `bot` | A simulation account used only in the simulation club and bot tournaments. Admins can filter these. |

### 3.2 Club-level roles

A user can hold several roles in a club. Every member is implicitly a **player**. The ranks are: owner 4 > manager 3 > inspector 2 > dealer 1 > (player 0).

| Role | Summary |
|---|---|
| **Owner** | Exactly one per club. Can do everything, including Diamonds, Club Level, billing, minting Points, posters, deleting the club and transferring ownership. |
| **Manager** | Everything except billing: members and roles below manager, settings, limits, messages, Points (except minting), the floor. |
| **Inspector** | Runs the floor: tables, dealers, requests, Send Out / Claim Back (from own stock), reports. |
| **Dealer** | Deals one table at a time. Cannot play on the table they are dealing. |
| **Player** | Plays with own Points. Can be set to watch-only. |

Staff-play rule: members holding manager, inspector or dealer roles **cannot place coupons in that club**. The owner can. Staff who want to play must use a separate player account (error `club.play_staff`). Nobody can play on a table they are currently dealing.

### 3.3 Role-management rules

These are enforced server-side. The client mirrors them.

- Platform admin: may change anything.
- **Grant or revoke a role** (actor A, target T, role r):
  - On one's own card, A may only toggle **dealer**, and only if A is manager or higher.
  - A must be manager or higher.
  - Owner: may toggle any role except owner. Ownership moves only by transfer.
  - Manager: may toggle a role only if rank(r) < rank(A) **and** T's highest rank < rank(A). A manager therefore can only grant or revoke inspector and dealer on members below manager. Only the owner sets Manager.
- **Remove a member**: not oneself. A is manager or higher, and either A is owner or T's highest rank < A's.
- **Set play mode (play / watch-only)**: A is manager or higher, and either the target is A, or A is owner, or T's highest rank < A's.
- **Transfer ownership**: owner only, to an existing member. The old owner becomes manager. Only the new owner can transfer it back.
- A club must always keep its owner. Owners cannot leave (they must transfer or delete first).

### 3.4 Permission matrix

Legend: ● allowed · ○ own scope only / conditional · — not allowed.

| Capability | Admin | Owner | Manager | Inspector | Dealer | Player | Watch-only |
|---|---|---|---|---|---|---|---|
| Place coupons / enter tournaments | — (not a member) | ● (not own dealt table) | — | — | — | ● | — |
| View tables, heat, history | ● | ● | ● | ● | ● | ● | ● |
| Points request / return | — | — | — | — | — | ● | ○ (inferred) |
| Deal (sit at table, run hands) | — | ○ (must hold dealer role, can self-grant) | ○ (same) | — | ● | — | — |
| Floor dashboard, open/close tables, assign/unseat dealer | ● | ● | ● | ● | — | — | — |
| Create / delete / archive table | ● | ● | ● | ● (inferred) | — | — | — |
| Edit table markets | ● | ● | ● | ● (inferred) | — | — | — |
| Edit table limits (min/max/cap/per-market) | ● | ● | ● | — (read-only) | — | — | — |
| Approve / reject Points requests | ● | ● | ● | ● | — | — | — |
| Approve / reject join requests | ● | ● | ● | ● | — | — | — |
| Approve dealer sit requests | ● | ● | ● | ● | — | — | — |
| Send Out / Claim Back | ● | ● (from pool) | ● (from pool) | ○ (from own stock) | — | — | — |
| Give / take inspector stock | ● | ● | ● | — | — | — | — |
| Mint Points | — (inferred) | ● | — | — | — | — | — |
| See Points supply / check | ● | ● | ● | — | — | — | — |
| Member list and member card | ● | ● | ● | ● | — | — | — |
| Change roles / play mode / remove member | ● | ● | ○ (rank rule) | — | — | — | — |
| Scan player code at desk | — | ● | ● | ● | — | — | — |
| Reports: Live, Hands, Analytics, Shift report | ● | ● | ● | ● | — | — | — |
| Club report (30-day) | ● | ● | ● | — | — | — | — |
| Tournaments: create / start / cancel / finish / pin / auto-deal | ● | ● | ● | ● | — | — | — |
| Sessions (open/close shift) | ● | ● | ● | ● | — | — | — |
| Club settings, profile, photo, rooms, live-big, dealer-seat approval | ● | ● | ● | — | — | — | — |
| Club messages: write/send/schedule | — | ● | ● | read-only log (inferred) | — | — | — |
| Posters | — | ● | — | — | — | — | — |
| Club account: Diamonds, Level, checkout, promo codes, notification prefs | ● (admin console) | ● | — | — | — | — | — |
| Accept club terms | — | ● | — | — | — | — | — |
| Transfer ownership / delete club | — | ● | — | — | — | — | — |
| Restore deleted club | ● | — | — | — | — | — | — |
| Platform admin console | ● | — | — | — | — | — | — |
| Simulation module | ● (simulation club only) | — | — | — | — | — | — |

Capability names seen in the client context: `club.billing` (owner-level billing), `club.owner`, `members.manage`. The server exposes the set of **surfaces** available to the current member in the active club (`player`, `dealer`, `inspector`, `members`, `settings`, `hub`, `account`). The navigation is built from that set.

---

## 4. Navigation map

Client routes are hash-based (`#/…`).

### 4.1 Public / unauthenticated

- `#/login`: login / register toggle, language switch, Google button (when configured), "forgot PIN", support link. If a pending invite or table join exists, it shows "you are invited to <club>" or "you are joining table <name>".
- `/c/<7-digit ClubID>`: server-rendered invite landing (Open Graph name, description and photo for link previews). Stores the pending invite and opens the app.
- `#/join/<joinCode>`: table QR landing. Verifies the code, then requires login, then sends the user to the table, or offers a join request if they are not a member.
- `#/pc/<code>`: player-code URL (only meaningful when scanned by staff).
- `#/tv/cash`, `#/tv/cash/<displayToken>`: Ring Game TV pairing and display.
- `#/tv/tournament`, `#/tv/tournament/<displayToken>`: Tournament TV pairing and display.
- Legal pages: player terms, privacy policy, club terms (`/legal/{player-terms|privacy-policy|club-terms}.{en|el}.html`).
- In-app-browser warning: inside Facebook/Instagram/Viber-type in-app browsers, Google sign-in is blocked. The app suggests opening the page in the system browser. PIN login still works.

### 4.2 Any signed-in user

- `#/clubs`: **Home / club hub**. Carousel of my clubs (tiles with live coupon count and "you won" badges), "Find / new" tile, Arena tile, find club by ID, create club, pending requests, club notices.
- `#/account`: My account (display name, sign-in & email, Google link, PIN change, marketing consent, language, delete account).
- Identity menu (top bar): FlopMe home, account, other clubs (switch), My code, Scan QR, Help, Contact us, Log out.
- Intro "hello" tour (first run), help sheets, coach marks.

### 4.3 Player surface (`#/player`)

- Club lobby / club home: tiles for everything the club is playing (Ring Game cards, tournaments, Arena), "what's playing" strip, club board, medals, notices and message cards.
- Table view ("play"): stage (hand state, flop, countdown), market picker by category, coupon slip, live coupons, heat board, tournament bar and standings (tournament tables).
- My games (up to 4 open tables at once), History (coupons, single picks, Points movements), Profile (stats, requests, rules & multipliers, medals, player code, language, sound).
- Points request / return sheet, Rules & multipliers screen, Messages inbox, Tournament lobby and detail, Arena screens.

### 4.4 Dealer surface (`#/dealer`)

- Table list (my table, available tables, sit / ask to sit, pending request, notices), console for the seated table, dealer menu (table QR, app QR, layout mode, stand up, back to my tables), recent hands.

### 4.5 Staff surface (inspector, manager, owner)

Bottom navigation with five tabs: **Tables · Members · Requests · Reports · Club**.

- Tables (`#/inspector` → floor): segments **Ring Games | Tournaments**. Floor exceptions, setup "next step", table rows by status group, create table, table sheet (open/close, assign/unseat dealer, markets & limits, lobby card, QR, TV, delete). Tournament control, monitor, logs, report.
- Members (`#/club/members`): list with search and filter (all / players), join requests waiting, Scan QR, member card (`#/club/card/<userId>`).
- Requests (`#/inspector/requests`): pending (Points in / Points out / join / dealer seat) and 30-day history.
- Reports (`#/inspector/reports`): segments **Live | Hands | Analytics | Report | Club** (Club only for owner or manager).
- Club (`#/club/hub`): grouped links.
  - "The club": Diamonds & Club Level (owner), Settings & first steps, Points supply, Message players, Posters (owner), App QR.
  - "Floor tools": Simulation (simulation club only), Tournaments.
  - "You": Play as a player (owner), switch club, language, help.
- `#/club/settings`, `#/club/account`, `#/club/messages`, `#/club/help`.

### 4.6 Platform admin (`#/admin`)

Nav: **Platform · Clubs · Accounts · Commerce · More**.

- Platform: KPIs, online now, devices, per-club figures, markets.
- Clubs: commerce clubs list, billing start, per-club account/enforcement/top-up, members.
- Accounts (`#/admin/accounts`): search, filters, account detail, create, edit, reset PIN, deactivate/reactivate.
- Commerce (`#/platform/commerce`): Catalogue · Payments · Codes · Audit.
- More (`#/admin/more/<x>`): hand history, reconciliation, audit log, market matrix (bet types), App QR, Arena report.

### 4.7 Surface switching

A member with several roles gets an "Open as" switcher: Player (lobby & tables), Dealer (my table), Staff (tables, members, requests), Members, Club settings. The current surface is marked. When roles change, the server pushes `club:context-changed` and the client re-reads the context and moves the user off any surface they lost.

---

## 5. Cross-cutting conventions

- **Money-like amounts** are integers in milli-units (`*Cents` in the API). The UI accepts at most 2 decimals, so values are multiples of 10 units.
- **Error envelope**: `{ error: string, code: "module.reason", params: {...} }`. The client localizes `err_<code with . and - replaced by _>` with `params`. Params may carry `$units` objects and `<name>El` Greek variants. See 15-error-codes.md.
- **Auth**: `Authorization: Bearer <token>`. A 401 with code `auth.session_ended` shows the "signed in elsewhere / PIN changed" screen.
- **Idempotency**: money-creating admin/owner actions send an `Idempotency-Key` header (mint Points, level upgrade, admin top-up).
- **Timezone**: report/analytics queries pass the browser IANA timezone (`tz`). Club days and session cut-off are local (06:00).
- **Audit**: every Points movement, role change, billing action and admin action is written to an immutable log with the actor.
- **Realtime**: one authenticated socket.io connection per client, which joins per-table rooms (see 14).
- **Bot / simulation data** is excluded from all club and platform financial figures unless the "Include simulation" toggle is on.

---

## 6. Open questions (consolidated)

Items marked (inferred) in the spec files need product confirmation. These are the most consequential ones:

1. **Play-charge unit.** The catalogue expresses the play charge as "pct% of every Point played (0–2%)", but the public price is "1 D per Point". Confirm the conversion (the spec assumes 1 PT = 100 D for rating, so 1% = 1 D/PT).
2. **Grace and pause parameters.** Unpaid play-charge grace days, the `maxD` pending cap, the renewal-overdue deadline, and the thresholds for the "low" and "critical" states.
3. **Level broadcast quotas** per Level after 2026-12-01, and whether rooms stay fixed at 1 for every Level.
4. **Diamond pack list** (sizes, euro prices, bonus %, "most popular"), Arena Star packs, and the Arena daily and monthly spending caps.
5. **Guaranteed prize pool behaviour** when collections exceed the GTD, payout rounding, and chip ties at finish.
6. **Timers.** Whether `bettingTimerSeconds` auto-closes picks, the no-more-bets grace countdown, the Arena and auto-deal intervals and "sleep" rules, and the TV display lifetime (the tour page says 24 h).
7. **Tournament exposure cap** (`coupon.over_exposure` pct) and the participation rounding (ceil or round).
8. **Heat band formula**, and whether `any-trips` / `straight-flush` should be offered as separate markets.
9. **PIN length.** The server accepts 4–8 digits but the player UI only takes 4. Confirm the product rule.
10. **Club restore window** (days), the simulation data retention days, and the Arena hand-retention days.
11. Whether the legacy auto-play, "repeat last picks" and venue geo-fence need to exist in GetFlop (spec says no).
12. Languages: the tour page shows Italian (`it`), but the app ships only `en` and `el`.
