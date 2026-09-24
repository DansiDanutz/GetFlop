# 12 · Billing & Commerce (Diamonds)

## 1. Diamonds

- **100 D = €1** (1 D = €0.01). Diamonds belong to a **club**, not a user. The owner buys them.
- Bought by card (Stripe Checkout), added manually by the platform (bank transfer or invoice top-up), or granted by promo code.
- **Validity: 12 months from purchase.** Spending is FIFO (oldest first). Expired lots produce ledger `expiry` and the account message "d D expired, 12 months after purchase".
- Points are never sold for Diamonds. There is a legacy catalogue kind "Point inventory rate" (D per Point) and ledger `point_purchase` ("Converted to Points"). Keep them for data compatibility, but Points minting is free (04 §3).

## 2. Only two charges

1. **Club Level**, every 30 days (from 0 D on Starter to 50,000 D).
2. **Play charge**: by default **1 D for every Point played**, charged to the club **after each hand**, never to the player. In tournaments only the **buy-in** counts, never the chips.
   - Catalogue kind `turnover_rate`: "pct% of every Point played (in Diamonds)", rate 0–2%. Interpretation: a Point is valued at 100 D for this purpose, so 1% = 1 D per Point (inferred; confirm).
   - Legacy kind `usage_rate`: D per "active player-hand", used before **2026-09-21**. Old charge rows render as "Active player-hand (the per-hand charge before 21 September 2026)".
   - A tournament entry charge row reads "Tournament entry · name · player". An unregister or cancel produces "Entry given back" (`usage_refund`).
   - Example (tour page): 1,600 Points played in an evening = 1,600 D = €16.

## 3. Club Levels (default catalogue)

Prices are per 30 days and exclude VAT.

| Level | Price | Members | Ring Games open at once | Tournaments running at once | Rooms | Promotional broadcasts / month |
|---|---|---|---|---|---|---|
| Starter | Free (0 D) | 30 | 1 | 0 | 1 | ? |
| Club 100 | €50 · 5,000 D | 100 | 2 | 1 | 1 | ? |
| Club 500 | €100 · 10,000 D | 500 | 5 | 2 | 1 | ? |
| Club 1K | €200 · 20,000 D | 1,000 | 8 | 3 | 1 | ? |
| Club 2.5K | €350 · 35,000 D | 2,500 | 12 | 5 | 1 | ? |
| Club 5K | €500 · 50,000 D | 5,000 | 20 | 8 | 1 | ? |

- Limits are **entitlements on the published catalogue version** and can change by publishing a new version. Broadcast quotas are unknown (open question). They only apply after the free messaging period ends on 2026-12-01.
- Capacity checks (errors in 15):
  - member approval → members
  - open table → Ring Games
  - start tournament → tournaments
  - add room → rooms
  - send promotional message → broadcasts
- Two message variants: the `_billing` variant for owners (suggests an upgrade to `nextLevel`), and the `_staff` variant for others ("ask an owner").
- **One free club per owner** (03 §1.1).

### 3.1 Changing Level

- **Quote**: `GET /commerce/club/level/quote?productId=` → `{proratedD, renewalDate, newLimits, …}`.
- **Upgrade** (applies **at once**): `POST /commerce/club/level/upgrade {productId}` with `Idempotency-Key`.
  - Charges the **prorated** price, and the renewal date moves.
  - Needs enough Diamonds (`commerce.level_insufficient_diamonds {costD, balanceD, shortfallD}`; the UI says "Buy Diamonds first").
  - `commerce.level_not_an_upgrade`, `commerce.level_not_on_sale`.
  - In the pilot, nothing is charged ("the price would be X D").
  - Proration formula (inferred): `ceil((newPrice − oldPrice) × remainingDays / 30)`. The response states the new renewal date.
- **Downgrade** (applies **at renewal**): `POST /commerce/club/level/downgrade {productId}`. Cancel it with `DELETE /commerce/club/level/downgrade`.
  - The confirm lists what must be reduced first. **No members or data are removed automatically.**
  - At renewal, if usage still exceeds the new limit, the downgrade does not take effect (`commerce.level_downgrade_blocked {used, newLimit, resource}`, sent as an account message).
  - Moving to Starter is blocked if the owner has another free club.
  - `commerce.level_not_a_downgrade`.

## 4. Billing modes

- **Free pilot** (default): play is measured, and Level and play charges are shown as **previews** (rows marked "measured, not charged" / "preview"). Nothing pauses.
- **Enforced**: charges are taken in Diamonds.
- Per club: the platform admin toggles `PUT /commerce/admin/clubs/:id/enforcement {enabled}` ("Enforce billing" / "Back to free pilot"). Unpaid charges already recorded stay on record.
- **Global billing start**: `POST /commerce/admin/billing-start {day}`. It schedules the end of the pilot for all clubs at **12:00 Greek time** on that day.
  - The day must be at least **N hours** ahead (`commerce.billing_start_too_soon {hours}`) and a valid date (`commerce.billing_start_date_invalid`).
  - Every owner is told at once, in the app and by email.
  - `DELETE /commerce/admin/billing-start` postpones it (owners told).
  - "Return every club to the pilot" is available. `commerce.billing_start_already_live` if it is already live.
- Owner banners:
  - "Free pilot: shown as previews".
  - "The free pilot ends on <date> at 12:00 (Greek time). From then every Point played is charged <rate> D."

## 5. Unpaid charges, grace and pause

- **Play charge the wallet cannot cover** is recorded as **pending** (unpaid). Play continues through a **grace period**: `days` after the first unpaid hand, **or** until pending charges reach `maxD`, whichever comes first. After that, **new hands pause** until it is settled.
  - Hands already accepted are never interrupted.
  - Balances and history are safe.
  - The grace days and `maxD` are server parameters.
- **Level renewal** that cannot be paid: state "Renewal overdue", with a deadline to add the shortfall. After the deadline:
  - new hands pause
  - member approvals pause
  - promotional broadcasts pause
  - existing hands continue
  - state becomes restricted ("Club billing is paused … pay X D")
- **Settlement**: any top-up or purchase first settles unpaid charges, **oldest first** (ledger `charge_settlement`). The account message "Play is available again. X D in outstanding charges was paid."
- Error codes while paused:
  - `commerce.paused_billing` / `commerce.paused_staff`
  - to players: `commerce.game_unavailable` ("temporarily unavailable, the club will let you know")
  - `commerce.tournament_unavailable`, `commerce.tournament_waiting`

### 5.1 Account states

| State | Meaning |
|---|---|
| `healthy` | Enough Diamonds |
| `low` | The runway forecast is below a threshold (inferred ~7 days) |
| `critical` | The next scheduled charge would not be covered soon |
| `usage_grace` | Diamonds pending (unpaid play charges, within grace) |
| `past_due_grace` | Renewal overdue, within its deadline |
| `restricted` | Paused |

In the pilot, the state is shown as "Preview only".

### 5.2 Forecast

- "Available after scheduled charges" = balance − Level renewals scheduled in the next 30 days − unpaid.
- **Runway** = available ÷ average daily spend over the last 7 days. "Not enough usage history" if there is too little. The Points-equivalent is also shown ("covers about X played").

### 5.3 Owner notice cards (`GET /commerce/club/notice`, `POST /commerce/club/notice/shown {kind:"diamonds"}`)

These are full-screen cards with the dealer mascot:

- Running low (about n player-hands / Points, about n days left)
- Almost gone
- **0 Diamonds**: "every table keeps playing for d days, or until pending reaches max D; then new hands pause"
- Diamonds pending (deadline, "n D left before the pause")
- Renewal overdue
- New hands are paused

Buttons: Later / Got it / Buy Diamonds.

## 6. Buying Diamonds

### 6.1 Packs

- Catalogue products of kind `diamond_pack`: `{diamonds, priceCents (EUR net), bonusPct?, mostPopular?}`. Pack labels: "d D for €x (+ VAT)", "+p% offer", "d bonus Diamonds", "Most popular". The actual pack list is unknown (open question).
- Purchase flow:
  1. The owner chooses a pack. The confirm shows "d Diamonds for <club>", "€x + VAT · card payment through Stripe", "They reach your club as soon as the payment goes through".
  2. The **mandatory consent** checkbox: the owner wants the Diamonds now and accepts losing the 14-day withdrawal right. "Why do we ask?" explains the EU withdrawal-right waiver for immediate digital delivery. Error `commerce.consent_required`.
  3. `POST /commerce/club/checkout {packVersionId, locale, promoCode?}` → `{url, orderId}`. Redirect to Stripe Checkout. **VAT is calculated by Stripe Tax** at checkout, based on the buyer's country.
  4. Return:
     - success: "Stripe has the payment; Diamonds are credited as soon as it clears"
     - cancel: "Payment cancelled. Nothing was charged"
     - failed: "Nothing was credited"
     - `GET /commerce/club/orders/:id` gives the status.
  5. **Webhook** (`checkout.session.completed` / `payment_intent.succeeded`):
     - Credit Diamonds (ledger `topup`) and settle unpaid charges first.
     - Account message "d D added · €x paid by card · balance".
     - The receipt is issued.
     - If the paid amount does not match the order, **nothing is credited** and an admin alert is raised (`payment_mismatch`).
- Order statuses: `pending`, `paid`, `expired`, `failed`, `refunded`. Test-mode orders are flagged TEST.
- Errors: `commerce.payments_unavailable` (card payments off; send a request instead), `commerce.payments_failed`, `commerce.pack_not_found`, `commerce.catalogue_missing`, `commerce.unclassified`, `commerce.forbidden` (billing is for the owner).

### 6.2 Manual top-up request (when card payments are off)

`POST /commerce/club/topup-request {packVersionId}`:

- "Request sent. FlopMe will add d D and the receipt will appear here." The pending request shows "Waiting: d D requested <date>".
- The admin sees "Diamond requests · n" and tops up (§10) or rejects (`POST /commerce/admin/topup-requests/:id/reject`; the club can ask again). `commerce.topup_request_not_found`.

### 6.3 Receipts and VAT documents

- Receipts are issued through the Greek invoicing provider **Elorus**. Modes: `live` (issued), `drafts` (drafts only), `off`.
- Receipt statuses: issued, drafted, sending, error, needs review, skipped (no receipt), void (voided or deleted in Elorus). Admin can retry: `POST /commerce/admin/orders/:id/receipt`.
- Admin alerts:
  - Elorus refused 5 times
  - a document needs a person
  - the receipt email may not have gone (resend by hand)
- Owner downloads:
  - `GET /commerce/club/orders/:id/receipt.pdf`
  - `GET /commerce/club/refunds/:id/credit.pdf`
  - Errors `commerce.document_not_found` (no issued document yet), `commerce.document_unavailable`.
- The receipt line shows: when, club, product and version, reference, and "Net · VAT · paid".

## 7. Refunds (platform admin only)

- Policy (shown to owners): unused Diamonds are **not refunded**, except for a double or wrong charge, Diamonds not credited, or a platform error. The owner must ask **within 14 days of the payment**.
- `POST /commerce/admin/orders/:id/refund {ground: "duplicate"|"not_credited"|"our_fault"}`:
  - Stripe returns the **whole payment** (VAT included) to the card.
  - The purchase's **unspent** Diamonds (up to the purchased amount) are removed at once (ledger `refund`).
  - Diamonds already spent stay spent and are reported as "short" (admin alert `refund_short`).
  - Elorus issues a **credit note**.
  - Irreversible.
  - Account message "Card refund of €x: d D taken back".
- Errors:
  - `commerce.refund_window_closed {days}`
  - `commerce.refund_not_refundable` (only paid card orders)
  - `commerce.refund_ground_invalid`
  - `commerce.refund_failed` (Stripe refused; nothing changed)
- **Chargebacks** (Stripe disputes) raise an admin alert "CHARGEBACK €x · reason · order". Nothing changes automatically, and the admin answers in Stripe.

## 8. Promo codes

| Kind | Effect |
|---|---|
| `gift` | Free Diamonds, added with no payment (not through Stripe, no receipt). Ledger `grant` |
| `percent` | 1–99% off a pack's **net** price at card checkout (through Stripe; VAT on the discounted amount). Can target any pack or one pack |

- Admin creation fields:
  - code (4–24 letters, digits or dashes; blank means generated; unique)
  - kind, value, pack (percent)
  - club (a specific club, or any club; "no owner is notified" for any club)
  - valid for 1–365 days
  - uses 1–10,000
  - A code for a specific club is sent to that owner's account messages ("FlopMe sent you the code …, redeem by <date>"). It is also copied to the clipboard.
- Validation errors: `commerce.promo_kind_invalid`, `value_invalid`, `days_invalid`, `uses_invalid`, `club_invalid`, `pack_invalid`, `code_invalid`, `code_taken`.
- Owner flow:
  - "Have a promo code?" → `POST /commerce/club/promo/check {code}` → `{kind, giftD | pct, packId?}`.
  - Gift: "This code gives d free Diamonds" with **Add the Diamonds** → `POST /commerce/club/promo/redeem {code}`.
  - Percent: the pack prices show "d D for €new instead of €old" and the code is applied at checkout.
- Redemption errors:
  - `promo_not_found` (does not exist or is not for this club)
  - `promo_inactive` (withdrawn), `promo_expired {date}`
  - `promo_already_used` (**one use per club**), `promo_used_up`
  - `promo_card_only` (a discount, so pay by card), `promo_gift_not_here` (use "Add the Diamonds"), `promo_wrong_pack`
- Code statuses: active, expired, used up, withdrawn (`POST /commerce/admin/promo-codes/:id/disable`; existing uses stay).
- Redemption states: `reserved` (at checkout), `used`, `released` (the checkout expired or was cancelled).

## 9. Account notifications and preferences

- Always sent (in-app, plus email to owners with a confirmed address):
  - receipts
  - unpaid charges
  - renewal notices and reminders ("<level> renews on <date> for d D; projected available d D")
  - renewals done
  - pauses and recoveries
  - price changes (a Level price changes at the next renewal; the current paid period is unchanged)
  - play-charge rate changes (announced **at least 30 days** ahead)
  - billing start or postpone
  - promo codes received
  - Diamonds expired
  - card refunds
- Optional (`PUT /commerce/club/notification-preferences`):
  - **Low Diamonds forecast** (in app / by email)
  - **Play charge summary** (in app / by email; cadence daily or weekly): "Play charge this period: n PTS played → d D. Balance d D", with mixed and preview variants
  - Error: "Preferences were not saved".

## 10. Platform catalogue (admin, `#/platform/commerce`)

Tabs: **Catalogue · Payments · Codes · Audit**.

### 10.1 Products and versions

- Product kinds:
  - `club_level` ("D / month")
  - `diamond_pack` ("d D for €x")
  - `turnover_rate` (play charge, %)
  - legacy `point_rate` (D per Point) and `usage_rate` (D per active player-hand)
- A **kind is a behaviour the server understands**: a new kind needs code.
- Product fields: code, kind, name (en), name (el). Lifecycle: `draft` → `active` ("on sale") → `archived`. A product is not sold until a version is published **and** it is put on sale. Update with `PUT /commerce/admin/products/:id {lifecycle}`.
- Versions:
  - `draft` → `published` → `withdrawn`. **A published version never changes; a correction is a new version.**
  - Draft fields: price in Diamonds, price in euro cents (packs), rate % (0–2, turnover), limits (levels: members, rooms, ring games, tournaments, broadcasts), effective from (empty means on publish), note.
  - Endpoints: `POST /commerce/admin/products` (create), `POST /commerce/admin/products/:id/drafts` (new draft), `PUT /commerce/admin/versions/:id` (save draft), `DELETE /commerce/admin/versions/:id` (delete a draft only), `GET /commerce/admin/versions/:id/preview` (impact), `POST …/publish`, `POST …/withdraw`.
- **Impact preview** before publishing:
  - "From <at> · price old → new D"
  - "n active clubs get it at their next renewal (the first on <at>)"
  - the limits diff, and clubs above the new limits
  - the notice text clubs will get
  - for a rate: "From <at> the play charge goes a% → b%; enforced clubs are told now; the date must be at least 30 days away"
- Publishing is audited. Purchases already made and current paid periods never change.
- Display: "In force: v<n> · <price>", "Scheduled: v<n> from <at>", "Draft v<n>".

### 10.2 Payments tab

- Config status: card payments on or off, VAT (Stripe Tax) on or off, Elorus receipts mode, refund window (days).
- Alerts (mark all read: `POST /commerce/admin/alerts/read`).
- Card orders: diamonds, status, when, buyer, net, VAT, total, country, failure reason, receipt state, refunds ("Refunded €x · d D taken back", "d D already spent"). Actions: retry receipt, refund.

### 10.3 Codes tab

Codes list with uses "used/max · expires", status, redemptions (used / at checkout / released), copy, withdraw, new code.

### 10.4 Audit tab

`GET /commerce/admin/audit`. Actions logged:

- product created or updated
- draft created, saved or deleted
- version published or withdrawn
- club billing switched
- code created or withdrawn

## 11. Diamond ledger (club)

Append-only. Types:

| Type | Meaning |
|---|---|
| `topup` | Diamonds added (card, or admin with a payment reference) |
| `point_purchase` | Legacy: converted to Points |
| `level_charge` | Level renewal or upgrade |
| `usage_charge` | Play charge |
| `usage_refund` | Play charge given back |
| `charge_settlement` | Unpaid charge settled |
| `expiry` | Expired (12 months) |
| `refund` | Card refund |
| `grant` | Free Diamonds (code) |

Each row carries a signed amount, the balance after, a reference (order, hand, tournament, code), and the actor.
