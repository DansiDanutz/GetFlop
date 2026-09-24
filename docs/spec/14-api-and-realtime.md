# 14 · REST API & Realtime

Base path: `/api`. JSON in and out. Auth: `Authorization: Bearer <token>`, except the public TV endpoints. Errors: HTTP 4xx/5xx with `{error, code, params}` (15). Amount fields named `*Cents` are integer **milli-units** (1 PT/TC/★ = 1000).

Methods below were read from the client's call sites (GET/POST/PUT/DELETE wrappers). Field lists come from request bodies and from how the client reads responses. Response shapes are **(inferred)** unless they are obvious from the client.

Conventions for the "Who" column: **P** player (member), **D** dealer, **I** inspector, **M** manager, **O** owner, **S** any staff (I/M/O), **A** platform admin, **U** any authenticated user, **pub** no auth.

## 1. Auth (`/auth`)

| Method | Path | Who | Body / query | Response / notes |
|---|---|---|---|---|
| POST | `/auth/register/code` | pub | `{username, displayName, pin, adult, acceptTerms, email, marketingEmail, lang}` | `{registrationId}`. Emails a 6-digit code |
| POST | `/auth/register` | pub | same + `{registrationId, code}` | `{token, user}` |
| POST | `/auth/login` | pub | `{username, pin, pwa, lang}` | `{token, user}`. Revokes other sessions |
| GET | `/auth/google/config` | pub | — | `{enabled, clientId}` |
| POST | `/auth/google` | pub | `{credential, pwa, lang}` | `{token, user}` or `{needsRegistration, registrationToken, email, suggestedUsername, emailTaken}` |
| POST | `/auth/google/register` | pub | `{registrationToken, username, displayName, pin, adult, acceptTerms, lang}` | `{token, user}` |
| POST | `/auth/google/link` | U | `{credential, pin}` | identity |
| DELETE | `/auth/google/link` | U | — | unlink |
| POST | `/auth/pin-reset/request` | pub | `{username, lang}` | always 200 |
| POST | `/auth/pin-reset/confirm` | pub | `{username, code, newPin}` | Revokes all sessions |
| POST | `/auth/pin/change` | U | `{pin, newPin}` | |
| GET | `/auth/identity` | U | — | `{email, emailVerified, google{linked,email}, googleEnabled, marketingEmail}` |
| POST | `/auth/email` | U | `{email, pin, lang}` | Sends a code |
| POST | `/auth/email/verify` | U | `{code}` | identity |
| POST | `/auth/consent` | U | `{marketingEmail}` | |
| GET | `/auth/terms` | U | — | `{required, version}` |
| POST | `/auth/accept-terms` | U | `{adult, acceptTerms}` | |
| PUT | `/auth/display-name` | U | `{displayName}` | |
| POST | `/auth/delete-account` | U | `{pin}` | |

## 2. Clubs (`/clubs`)

| Method | Path | Who | Body / query | Response / notes |
|---|---|---|---|---|
| GET | `/clubs` | U | — | Legacy list of clubs (admin/tournament pickers) |
| GET | `/clubs/mine` | U | — | `{clubs[{id, name, publicId, logoUrl, membershipStatus, roles, memberCount, tableCount, liveCoupons, awayWinCents}], activeClubId, me}` |
| GET | `/clubs/context` | U | — | Active club `{club{id, name, publicId, kind, roles, surfaces, capabilities, levelLocked, setup}, me{welcomeDue}}` |
| POST | `/clubs/select` | U | `{clubId}` | Sets the active club. Emits `club:switched` to the user's other sockets |
| POST | `/clubs` | U | `{name, description, acceptClubTerms}` | club |
| GET | `/clubs/find/:publicId` | U | — | `{club{id, name, description, logoUrl, publicId, memberCount, tableCount, membershipStatus}}` |
| POST | `/clubs/:id/join` | U | `{source: "club_id"|"invite"|"qr"}` | pending membership. Emits `join-request:new` to staff |
| POST | `/clubs/:id/leave` | P | `{reason?}` | `{returnedCents}` |
| POST | `/clubs/:id/accept-terms` | O | `{acceptClubTerms:true}` | |
| GET | `/clubs/onboarding` | U | — | `{scenarios{player|dealer|inspector|manager|owner: [seenCodes]}, staff}` |
| POST | `/clubs/onboarding/seen` | U | `{code, scenario}` | |
| GET | `/clubs/notices` | U | — | `{notices[{id, code, params}]}` |
| POST | `/clubs/notices/:id/read` | U | — | |
| GET | `/clubs/player-code` | U | — | `{code}` (rotates every 60 s) |
| POST | `/clubs/:id/scan` | S | `{code}` | `{state: active|pending|left|removed|none, player, endedAt?}` |
| POST | `/clubs/:id/scan/request` | S | `{code, confirmReturn}` | Join request on the player's behalf |
| GET | `/clubs/:id/join-requests` | S | — | `{requests[{membershipId, userId, username, displayName, source, wasWatch, createdAt}]}` |
| POST | `/clubs/:id/join-requests/:membershipId/approve` \| `/reject` | S | `{}` | Emits `join-request:resolved`, and `club:membership-changed` to the user |
| GET | `/clubs/:id/setup` | S | — | `{setup{complete, done, total, steps[{key, done, optional}]}}` |
| GET | `/clubs/:id/settings` | M/O | — | settings |
| PUT | `/clubs/:id/profile` | M/O | `{name?, description?, logo?}` | |
| GET/PUT | `/clubs/:id/dealer-sit-approval` | M/O | `{on}` | |
| GET/PUT | `/clubs/:id/live-big` | M/O | `{bigPoints}` | |
| POST | `/clubs/:id/rooms` | M/O | `{name}` | |
| PUT | `/clubs/:id/rooms/:roomId` | M/O | `{name}` | |
| DELETE | `/clubs/:id/rooms/:roomId` | M/O | — | |
| GET | `/clubs/:id/delete-check` | O | — | `{blockers{openTables, tournaments, requests, returns, seatedDealers, liveCoupons}, members, pointsCents, diamonds, restoreDays}` |
| POST | `/clubs/:id/delete` | O | `{confirmName, reason}` | |
| GET | `/clubs/:id/members` | S | — | `{actor, members[]}` |
| GET | `/clubs/:id/members/:userId` | S | `dateStart, dateEnd, tz` | Member card `{member, stats{period, all}, markets[], movements[], stockCents?}` |
| GET | `/clubs/:id/members/:userId/coupons` | S | `dateStart, dateEnd, tz, offset` | `{coupons[], more}` |
| GET | `/clubs/:id/members/:userId/coupons/:couponId` | S | — | Coupon with draws |
| POST | `/clubs/:id/members/:userId/roles/:role` | M/O | `{}` | Grant. Emits `club:context-changed` to the target |
| DELETE | `/clubs/:id/members/:userId/roles/:role` | M/O | — | Revoke |
| PUT | `/clubs/:id/members/:userId/play-mode` | M/O | `{mode: "play"|"watch"}` | |
| POST | `/clubs/:id/members/:userId/remove` | M/O | `{reason?}` | `{returnedCents}` |
| POST | `/clubs/:id/members/:userId/stock` | M/O | `{direction: "give"|"take", amount, note?}` | |
| POST | `/clubs/:id/owner/transfer` | O | `{userId}` | |
| GET | `/clubs/:id/points` | M/O | — | Supply statement (04 §2) |
| POST | `/clubs/:id/points/mint` | O | `{amount, reason}` + `Idempotency-Key` | |
| GET | `/clubs/:id/board` | P | — | Club board (03 §11) |
| POST | `/clubs/:id/board/hidden` | P | `{hidden}` | |
| GET | `/clubs/:id/bar` | P | — | `{board{rank}, balanceCents, closesAt, pendingRequest}` |
| GET | `/clubs/:id/medals` | P | — | Club medals with progress |

## 3. Player (`/player`)

| Method | Path | Who | Body / query | Response / notes |
|---|---|---|---|---|
| GET | `/player/profile` | P | — | Balance and lifetime stats in the active club |
| GET | `/player/tables` | P | — | `{tables[], clubPaused, dealSeconds}` (Arena tables carry `dealClock`) |
| POST | `/player/table/:id/join` | P | `{}` | `{table{…limits, canPlay, playBlockedBy, isDealingHere, dealClock}, betTypes[], activeHand, activeTournament, tournamentRegistration, tournamentLevel}` |
| GET | `/player/table/:id/heat` | P | — | Heat board (01 §8) |
| POST | `/player/table/:id/sim-step` | P (sim) | `{}` | Advance a simulation step |
| GET | `/player/tables/latest-settled` | P | `ids=a,b,c` | `{tables{[id]: {handId, settledAt, cards, matchingSlugs, isTournament, mine[{status,…}]}}}` |
| GET | `/player/my-games` | P | — | `{games[{tableId, tableName, kind, state, handNumber, liveCoupons, committedCents, tournamentId, tournamentName, scheduledAt, handCount, endValue, participation, urgency}]}` |
| POST | `/player/coupon` | P | `{tableId, selections[{betTypeId, stakeCents}], rounds}` | `{couponId, rounds, totalCommitmentCents, balanceCents, unit, isTournament}` |
| GET | `/player/coupons` | P | `status=live&tableId` | `{coupons[]}` |
| GET | `/player/coupon/:id/draws` | P | — | Flop-by-flop results |
| GET | `/player/history` | P | `limit=30` | `{coupons[], bets[], transactions[]}` |
| GET | `/player/requests` | P | — | `{reloads[], cashouts[]}` |
| POST | `/player/reload-request` | P | `{amountCents}` | Emits `request:new` to staff |
| POST | `/player/cashout-request` | P | `{amountCents}` | ditto |
| GET | `/tables/:joinCode/info` | pub/U | — | `{id, name, kind, status, activeHandStatus, activeHandNumber, club}` |

## 4. Dealer (`/dealer`)

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| GET | `/dealer/tables` | D | — | My seated table(s) |
| GET | `/dealer/available-tables` | D | — | `{tables[], needsApproval, pending}` |
| POST | `/dealer/table/:id/sit` | D | `{}` | Seat, or create a sit request (emits `dealer-sit:new`) |
| POST | `/dealer/table/:id/switch` | D | `{heldTableId}` | Leave the held table and sit or ask here |
| POST | `/dealer/table/:id/leave` | D | `{}` | Stand up |
| POST | `/dealer/held/leave` | D | `{}` | `{table, club}` |
| POST | `/dealer/sit-requests/:id/cancel` | D | `{}` | |
| GET | `/dealer/notices` | D | — | `{notices[]}` |
| POST | `/dealer/notices/:id/read` | D | `{}` | |
| GET | `/dealer/table/:id/current-hand` | D | — | Hand, or null |
| GET | `/dealer/table/:id/hands` | D | `limit=20` | `{hands[]}` |
| POST | `/dealer/table/:id/start-hand` | D | `{}` | `{hand, bettingTimerSeconds?}` |
| POST | `/dealer/table/:id/no-more-bets` | D | `{}` | |
| POST | `/dealer/table/:id/enter-flop` | D | `{card1, card2, card3}` | Settles |
| POST | `/dealer/table/:id/scan-flop` | D | `{image (base64 JPEG), mediaType}` | `{cards[], confidence}` |
| POST | `/dealer/table/:id/cancel-hand` | D | `{}` | |

## 5. Inspector / floor (`/inspector`)

| Method | Path | Who | Body / query | Notes |
|---|---|---|---|---|
| GET | `/inspector/dashboard` | S | — | `{stats, tables[]}` |
| GET | `/inspector/tables` | S | — | `{tables[]}` (07 §1) |
| GET | `/inspector/rooms` | S | — | rooms |
| GET | `/inspector/dealers` | S | — | `[{id, username, display_name, assigned_table, assigned_table_id, busy_elsewhere}]` |
| POST | `/inspector/table` | S | `{name, roomId?, allowedBetTypeIds?, minBetCents?, maxBetCents?, maxCouponCommitmentCents?}` | Create |
| PUT | `/inspector/table/:id/open` | S | `{dealerId, leaveHeld?}` | |
| GET | `/inspector/table/:id/close-preview` | S | — | 07 §2.3 |
| PUT | `/inspector/table/:id/close` | S | `{}` | Voids coupons |
| GET | `/inspector/table/:id/delete-preview` | S | — | `{mode, history, dealer, blocked}` |
| DELETE | `/inspector/table/:id` | S | — | Delete or archive |
| POST | `/inspector/table/:id/assign` | S | `{dealerId}` | Emits `dealer:seat{assigned}` |
| POST | `/inspector/table/:id/unseat` | S | `{}` | Emits `dealer:seat{unseated}` |
| GET/PUT | `/inspector/table/:id/bet-types` | S | `{allowedBetTypeIds}` | `[]` means all |
| PUT | `/inspector/table/:id/limits` | M/O | `{minBetCents, maxBetCents, maxCouponCommitmentCents, marketLimits[{betTypeId, maxStakeCents}]}` | |
| PUT | `/inspector/table/:id/lobby-card` | S | `{game, featured, photo?}` | |
| POST | `/tables/:id/generate-code` | M/O | `{}` | `{joinCode}` |
| GET | `/inspector/requests` | S | — | `{reloads[], cashouts[], dealerSits[], myStock}` |
| GET | `/inspector/requests/history` | S | `days=30` | |
| POST | `/inspector/request/:id/approve` | S | `{}` | |
| POST | `/inspector/request/:id/reject` | S | `{reason}` | |
| POST | `/inspector/dealer-sit/:id/approve` \| `/reject` | S | `{}` | |
| POST | `/inspector/player/:userId/load` \| `/withdraw` | S | `{amountCents, note?}` | Send Out / Claim Back |
| GET | `/inspector/wallet-drift` | S | — | `{driftingCount, worstDriftCents, checked}` |
| GET | `/inspector/live/bets` | S | `tz, tableId?, wins?, big?` | `{window{kind, number, since}, totals{stakedCents, paidCents, clubCents}, rows[]}` |
| GET | `/inspector/live/points` | S | `tz, actor?` | `{window, totals{givenCents, takenCents, netCents}, rows[]}` |
| GET | `/inspector/results` | S | `tableId, dateStart, dateEnd, tz` | `{hands[]}` |
| GET | `/inspector/hands/:handId` | S | — | Hand detail with players and picks |
| GET | `/inspector/summary` | S | `tableId, dateStart, dateEnd, all, tz` | |
| GET | `/inspector/report` | S | `fromDatetime, toDatetime, tableIds` | Shift report |
| GET | `/inspector/club-report` | M/O | `dateStart, dateEnd, all, tz` | `{results, players, points, diamonds}` |
| GET | `/inspector/analytics` | S | `sessionId` \| `from,to`; `includeBots`, `source` | |
| GET | `/inspector/session` | S | — | `{open, recent[]}` |
| POST | `/inspector/session/open` \| `/close` | S | `{}` | |
| GET | `/inspector/simulation` | — | — | UI route (hub → simulation) |

## 6. Tournaments (`/tournaments`)

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| GET | `/tournaments` | P/S | — | `{tournaments[]}` for the active club |
| GET | `/tournaments/clubs/list` | S | — | Clubs the caller can create in |
| GET | `/tournaments/bet-types/list` | U | — | Active markets |
| POST | `/tournaments` | S | See 10 §1 | Create |
| GET | `/tournaments/:id` | P/S | — | `{tournament, levels, payouts, registration, myParticipation, standings}` |
| POST | `/tournaments/:id/register` \| `/unregister` | P | `{}` | |
| POST | `/tournaments/:id/rebuy` \| `/addon` | P | `{}` | |
| POST | `/tournaments/:id/pin` \| `/start` \| `/cancel` \| `/finish` | S | `{}` | |
| POST | `/tournaments/:id/auto-deal` | S | `{intervalSeconds}` | 5–120 |
| DELETE | `/tournaments/:id/auto-deal` | S | — | Stop |
| GET | `/tournaments/:id/monitor` | S | — | |
| GET | `/tournaments/:id/logs` | S | — | `{events[]}` |
| GET | `/tournaments/:id/report` | S | — | |

## 7. Messages (`/messages`)

| Method | Path | Who | Body / query | Notes |
|---|---|---|---|---|
| GET | `/messages` | P | — | Inbox |
| POST | `/messages/read-all` | P | `{}` | |
| GET/PUT | `/messages/prefs` | P | `{promoMuted}` | Per active club |
| POST | `/messages/:id/tap` | P | `{}` | Button tapped |
| GET | `/messages/:id/photo` | P | — | Photo data |
| GET | `/messages/cards` | P | — | Pending photo cards |
| POST | `/messages/:id/card-shown` | P | `{}` | |
| GET | `/messages/audiences` | M/O | `tz` | `{audiences[{key, count, muted, capped}]}` |
| GET | `/messages/players` | M/O | — | Members for "one member" |
| GET | `/messages/targets` | M/O | — | `{tables[], tournaments[]}` |
| GET | `/messages/suggestions` | M/O | `tz` | `{suggestions[]}` |
| POST | `/messages/suggestions/:key/dismiss` | M/O | `{}` | |
| POST | `/messages` | M/O | `{title, body, tz, audience \| recipientId, action?{type, ref}, sendAt?, photo?}` | `{scheduled, sendAt, recipientCount}` |
| GET | `/messages/sent` | S | `limit=30, before?` | `{messages[], scheduled[]}` |
| POST | `/messages/:id/cancel` | M/O | `{}` | Scheduled only |

## 8. Arena (`/arena`)

| Method | Path | Who | Body / query | Notes |
|---|---|---|---|---|
| GET | `/arena/summary` | U | — | `{open, stars, …}` |
| POST | `/arena/enter` | U | `{}` | Join, or claim a refill |
| GET | `/arena/bar` | U | — | `{rank, weekOf, balanceCents, refill{under, ready, nextAt, amount}, shop{open}}` |
| GET | `/arena/board` | U | `period=week|all` | |
| POST | `/arena/board-visibility` | U | `{hidden}` | |
| GET | `/arena/medals` | U | — | Badges |
| GET | `/arena/packs` | U | — | Packs and caps |
| POST | `/arena/checkout` | U | `{packId, consent, locale}` | `{url, orderId}` |
| POST | `/arena/orders/:id/cancel` | U | `{}` | |

## 9. Commerce, club side (`/commerce/club`, owner)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/commerce/club/state` | — | Diamond chip and state |
| GET | `/commerce/club/dashboard` | — | Full account (08 §5) |
| GET | `/commerce/club/charges` | `limit, before?` | Play charges |
| GET | `/commerce/club/notice` | — | Pending Diamond notice card |
| POST | `/commerce/club/notice/shown` | `{kind:"diamonds"}` | |
| POST | `/commerce/club/notifications/read` | `{}` | |
| PUT | `/commerce/club/notification-preferences` | `{lowBalance{inApp,email}, usageSummary{inApp,email,cadence}}` | |
| POST | `/commerce/club/promo/check` | `{code}` | |
| POST | `/commerce/club/promo/redeem` | `{code}` | Gift codes |
| POST | `/commerce/club/topup-request` | `{packVersionId}` | Manual request |
| POST | `/commerce/club/checkout` | `{packVersionId, locale, promoCode?}` | `{url, orderId}` |
| GET | `/commerce/club/orders/:id` | — | Order status |
| GET | `/commerce/club/orders/:id/receipt.pdf` | — | PDF (blob) |
| GET | `/commerce/club/refunds/:id/credit.pdf` | — | PDF (blob) |
| GET | `/commerce/club/level/quote` | `productId` | |
| POST | `/commerce/club/level/upgrade` | `{productId}` + `Idempotency-Key` | |
| POST | `/commerce/club/level/downgrade` | `{productId}` | |
| DELETE | `/commerce/club/level/downgrade` | — | Keep the current Level |

Also required: a **Stripe webhook** endpoint (for example `POST /api/commerce/stripe/webhook`, raw body with signature verification) for Diamond and Star orders, refunds and disputes. It is not visible in the client.

## 10. Commerce, admin side (`/commerce/admin`, A)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/commerce/admin/clubs` | — | Clubs billing list |
| GET | `/commerce/admin/clubs/:id` | — | Club account |
| PUT | `/commerce/admin/clubs/:id/enforcement` | `{enabled}` | |
| POST | `/commerce/admin/clubs/:id/topup` | `{diamonds, reference, note, requestId}` + `Idempotency-Key` | |
| POST | `/commerce/admin/topup-requests/:id/reject` | `{}` | |
| POST / DELETE | `/commerce/admin/billing-start` | `{day}` | Schedule or postpone |
| GET | `/commerce/admin/catalogue` | — | Products and versions |
| POST | `/commerce/admin/products` | `{code, kind, nameEn, nameEl}` | |
| PUT | `/commerce/admin/products/:id` | `{lifecycle}` | |
| POST | `/commerce/admin/products/:id/drafts` | `{}` | |
| PUT | `/commerce/admin/versions/:id` | draft fields | |
| DELETE | `/commerce/admin/versions/:id` | — | Drafts only |
| GET | `/commerce/admin/versions/:id/preview` | — | Impact |
| POST | `/commerce/admin/versions/:id/publish` \| `/withdraw` | `{}` | |
| GET | `/commerce/admin/payments` | — | Config, alerts, orders |
| POST | `/commerce/admin/alerts/read` | `{}` | |
| POST | `/commerce/admin/orders/:id/receipt` | `{}` | Retry the receipt |
| POST | `/commerce/admin/orders/:id/refund` | `{ground}` | |
| GET / POST | `/commerce/admin/promo-codes` | create fields | |
| POST | `/commerce/admin/promo-codes/:id/disable` | `{}` | |
| GET | `/commerce/admin/audit` | — | |

## 11. Platform admin (`/admin`, A)

| Method | Path | Query / body |
|---|---|---|
| GET | `/admin/platform` | `dateStart, dateEnd, tz` |
| GET | `/admin/platform/arena` | `period` |
| GET | `/admin/live` | — |
| GET | `/admin/tables` | — |
| GET | `/admin/hands` | `tz, dateStart, dateEnd, tableId, handNumber` |
| GET | `/admin/hands/:id/bets` | — |
| POST | `/admin/bets/:id/void` | `{reason}` |
| GET | `/admin/financials/reconciliation` | — |
| GET | `/admin/financials/daily-player-net` | — |
| GET | `/admin/audit` | `page, limit, action` |
| GET | `/admin/bet-types` | — |
| PUT | `/admin/bet-types/:id` | `{payout_odds, probability?, fair_odds?, is_active}` |
| GET | `/admin/accounts` | `filter, q, limit, offset` |
| GET | `/admin/players/:id/detail` | — |
| GET / POST | `/admin/users` | `{username, displayName, role, pin}` |
| PUT | `/admin/users/:id` | `{username, displayName}` |
| PUT | `/admin/users/:id/toggle-active` | `{active}` |
| PUT | `/admin/users/:id/reset-pin` | `{newPin}` |

Club restore: the admin endpoint is not visible in the client (for example `POST /admin/clubs/:id/restore`). It is required by 03 §12.

## 12. Simulation (`/simulation`, A in the simulation club)

`GET /simulation/status|bots|report|budget`. `POST /simulation/start {tableId, botIds, autoApprove}`, `/stop`, `/purge`, `/table`, `/auto-approve {enabled}`, `/budget/release`, `/table/:id/new-hand`, `/table/:id/no-more-bets`, `/table/:id/deal [{card1..3}]`.

## 13. TV

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| POST | `/tv/cash-pairings` | S | `{tableId}` | `{pairingCode, expiresInMinutes}` |
| POST | `/tv/tournament-pairings` | S | `{tournamentId}` | same |
| POST | `/tv/cash-sessions` | S | `{tableId}` | `{token, expiresAt}` (revokes the previous one) |
| POST | `/tv/tournament-sessions` | S | `{tournamentId}` | same |
| POST | `/api/tv/cash-pairings/claim` | pub | `{code}` | `{displayToken, tableName}`. Rate-limited |
| POST | `/api/tv/tournament-pairings/claim` | pub | `{code}` | `{displayToken, tournamentName}` |
| GET | `/api/tv/cash/:displayToken` | pub | — | Display payload. 410 when expired |
| GET | `/api/tv/tournament/:displayToken` | pub | — | Display payload. 410 when expired |

## 14. Static and public

- `/c/:publicId`: server-rendered invite page (Open Graph meta `flopme-club-name`, description, image). It boots the app.
- `/legal/{player-terms|privacy-policy|club-terms}.{en|el}.html`.
- `/manifest.json`, service worker, card images `/cards/<code>.webp`, mascot images, win sounds `/win/win-{a,b}.mp3`.

## 15. Client routes (hash)

`#/login`, `#/clubs`, `#/account`, `#/player`, `#/dealer`, `#/inspector[/requests|reports|live|results|analytics|report|club-report|tournaments|simulation]`, `#/club/members[/<clubId>]`, `#/club/card/<userId>` (admin: `/<clubId>/<userId>`), `#/club/hub`, `#/club/settings`, `#/club/account`, `#/club/messages`, `#/club/help`, `#/join/<code>`, `#/pc/<code>`, `#/tv/cash[/<token>]`, `#/tv/tournament[/<token>]`, `#/admin`, `#/admin/accounts`, `#/admin/account/<id>`, `#/admin/more[/<hands|reconciliation|audit|bettypes|arena>]`, `#/platform/commerce`.

---

## 16. Realtime (socket.io)

### 16.1 Connections

- **App socket**: `io({auth:{token}})`, transports websocket then polling. The client reconnects up to 20 times (1–5 s backoff, 0.5 jitter). On connect the client re-emits `join-table` for every table it follows.
- **TV socket**: `io({auth:{displayToken}})`, reconnects forever (1–10 s backoff). The server puts it in the room of its table or tournament only.
- Server room model (inferred):
  - `user:<userId>` (all sockets of a user)
  - `club:<clubId>:staff` (inspector, manager, owner of a club)
  - `table:<tableId>` (joined via `join-table`)
  - `tournament:<id>`
  - `tv:<token>`

### 16.2 Client → server

| Event | Args | Meaning |
|---|---|---|
| `join-table` | `(tableId, {as?: "player"})` | Subscribe to a table room. The server verifies membership or staff rights. Dealers join without `as` |
| `leave-table` | `(tableId)` | Unsubscribe |

### 16.3 Server → client

| Event | Room | Payload | Consumers |
|---|---|---|---|
| `session:ended` | user | `{reason, deviceLabel}` | All: force logout |
| `hand:started` | table (+tv, staff) | `{tableId, handId, handNumber, hand, bettingTimerSeconds?}` | Player, dealer, floor, TV, Arena clock |
| `hand:no-more-bets` | table | `{tableId, handId, countdown}` | Player overlay, dealer |
| `hand:betting-closed` | table | `{tableId, handId}` | All |
| `hand:flop-revealed` | table | `{tableId, handId, card1, card2, card3}` | Player, monitor, TV |
| `hand:settled` | table | `{tableId, handId, card1..3, matchingSlugs, winners[], losers[], totalPaidOut, totalWagered, isTournament, unit}` | All |
| `hand:cancelled` | table | `{tableId, handId}` | All |
| `bet:placed` | table / staff | `{tableId, handId, username, betTypeName, amountCents, isTournament}` | Tournament monitor, simulation |
| `bet:cancelled` | table / staff | `{tableId, handId, betId}` | Monitor |
| `coupon:placed` | table | `{tableId, couponId}` | Dealer counts, floor |
| `coupon:round-placed` | user | `{couponId, handId, bets[]}` | Player |
| `coupon:round-settled` | user | `{couponId, handId}` | Player |
| `coupon:completed` | user | `{couponId, wonCents, committedCents, unit}` | Player toast |
| `coupon:voided` | user | `{couponId, refundCents, roundsUnresolved, unit}` | Player toast |
| `coupon:leg-cancelled` | user | `{couponId, betTypeId, refundCents, unit}` | Player toast |
| `balance:updated` | user | `{clubId, balanceCents}` | Header balance (flashes on increase) |
| `request:new` | club staff | `{requestId, type}` | Requests badge and toast |
| `request:resolved` | club staff | `{requestId, byUserId}` | Refresh, except the actor |
| `request:actioned` | user | `{type: "reload"|"cashout", status, amountCents}` | Player receipt and animation |
| `join-request:new` / `join-request:resolved` | club staff | `{membershipId}` | Requests |
| `dealer-sit:new` / `dealer-sit:resolved` | club staff | `{sitId, tableId}` | Requests |
| `dealer:seat` | user (dealer) | `{status: approved|assigned|rejected|taken|unseated, tableId, tableName}` | Dealer |
| `floor:changed` | club staff | `{}` | Floor refresh (debounced) |
| `live:changed` | club staff | `{kind: "bets"|"points"}` | Reports → Live |
| `notice:new` | user | `{code, params}` | Toast `notice_<code>` |
| `message:new` | user | `{messageId, clubId}` | Inbox badge |
| `club:context-changed` | user | `{clubId, quiet?}` | Re-read the context (roles changed) |
| `club:switched` | user | `{clubId}` | Other windows re-pick the club |
| `club:membership-changed` | user | `{status: "approved"|"rejected"|"removed", clubId, clubName}` | Home and redirect |
| `tournament:registered` / `unregistered` / `rebuy` / `addon` | tournament (+club) | `{tournamentId, username}` | Lobby, monitor, TV |
| `tournament:started` / `cancelled` / `finished` | tournament (+club) | `{tournamentId, …standings?}` | Lobby, player, TV |
| `tournament:level:updated` | tournament | `{tournamentId, levelNumber, minBetChips, maxBetChips}` | Player bar, TV |
| `tournament:chips:updated` | user / tournament | `{tournamentId, chips, username?}` | Player, monitor, TV |
| `tournament:player:busted` | tournament | `{tournamentId, username}` | Player, monitor, TV |
| `arena:badges` | user | `{badges[codes]}` | Arena |

Ordering guarantee: for one hand, `hand:started` < `hand:no-more-bets` < `hand:betting-closed` < `hand:flop-revealed` < `hand:settled`. Per-user coupon and balance events for a settle are emitted after the DB commit.
