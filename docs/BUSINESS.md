# GetFlop: the business

## What we sell

Live flop betting on real dealer-dealt poker hands, from our own poker club, and later from partner clubs' tables. It works like live-casino games (live blackjack, live roulette), but the "game" is a real poker hand already being played: the cards are free content we already produce every few minutes.

## Where the money comes from

| Stream | How it works | In the code |
|---|---|---|
| Our own players (direct) | We keep 100% of GGR (stakes lost minus winnings paid). | `GetFlop Direct` operator, commission 0% |
| Partners (B2B) | Partners bring their players and keep their bankroll. They pay us a share of the GGR their players generate, e.g. 12–20%. Losing months are carried forward and offset before commission is due again (standard revenue share). | `src/billing.ts`, Admin → Commission |
| Tournament fees | A % of every buy-in (rake). | `rakeBps` per tournament |
| Later: setup/licence fees | One-off onboarding fee per partner, or a monthly minimum. | not built |

**House margin.** Odds are set from the exact probability of each market over all 22,100 possible flops, minus a margin (default 5%). Odds are always rounded down, so the real edge is never below the configured margin. `npm run odds` prints the current price list. Example at 5%: Rainbow 2.38, Paired 5.60, At least one Ace 4.37, Trips 403.75.

**What GGR looks like.** With a 5% margin, expect the long-run hold to be about 5% of stakes. Short-term it swings: one Trips hit at 403× can wipe out a day. The risk limits below exist for that.

## Risk controls (money)

- **Per-bet limits** per table: min stake, max stake, max payout per bet. All table limits are amounts in the player's currency and apply to each currency separately (a 1,000.00 cap means up to 1,000.00 EUR *and* 1,000.00 USD on one hand). There is deliberately no currency conversion; if a table takes several currencies, set the limits for the riskiest one.
- **Per-hand liability cap.** For every open hand we know, for each of the 22,100 flops, exactly what the house would pay. A bet is refused if the worst flop would cost more than the table's cap. Bets on opposite outcomes offset each other, so the cap limits real risk and doesn't just count stakes.
- **Double-entry ledger.** Every movement is balanced; Admin → Audit & integrity proves that balances equal entries and every currency sums to zero.
- **Idempotency everywhere.** Partner deposits, withdrawals and wallet calls carry transaction IDs; retries never double-pay.

## Game integrity (the biggest risk in this product)

People physically at the table have information remote bettors don't:

1. **Seated players know their hole cards.** Holding A♠A♥ makes "at least one ace" on the flop much less likely. **Rule: players seated at a table (and the dealer) must not bet on that table.** The dealer console has a *Seated players* panel: staff check players in when they sit down. A seated player's bets on that table are refused (cash and tournament), and any bets they already had on the hand being dealt are returned. Make check-in part of seating a player, the same as taking the buy-in. Staff accounts are separate from player accounts and cannot bet.
2. **Betting closes before the burn card.** The dealer presses NO MORE BETS before burning. Betting also closes automatically when the timer ends. The server rejects any late bet, whatever the client shows.
3. **Stream delay.** If there is a video stream, remote players see events late. Closing before the burn card covers this, because nothing about the flop is visible yet.
4. **Wrong flop entry, by mistake or on purpose.** Tables can require **dual confirmation**: a second staff member enters the same three cards independently. Mismatches are logged and both must re-enter. Every flop, void and limit change goes into a **hash-chained audit log** that can't be edited silently. Record the table on camera with timestamps.
5. **Misdeals.** A supervisor (not a dealer) can void a hand. All stakes are returned and the reason is logged.

## Before taking real money

This is software, not a licence. Real-money betting and paid-entry tournaments are regulated gambling almost everywhere.

- **Licence.** You need a gambling licence where you operate (B2C), and a supplier/B2B licence to provide the game to partners in most regulated markets. Talk to a gaming lawyer first; this decides which countries you can accept players from.
- **KYC / AML / age checks** for direct players (identity verification provider, source of funds checks above thresholds).
- **Responsible gambling:** built for direct players (Play → Safer play): 24-hour and 7-day loss limits, a 7-day deposit limit at the cashier, time-outs (1–30 days) and self-exclusion (6 months to 5 years). Lower limits apply at once; higher ones after a 24-hour cooling-off; a break cannot be shortened. Every change is in the audit log. Partners handle this for their own players. Still to add before real money: a national self-exclusion register check and reality-check reminders, where the licence requires them.
- **Payments** for direct players. The cashier today is manual, for the club desk. Connect a licensed payment provider.
- **Game certification.** Regulators usually want the game rules, the odds and the settlement logic tested by an accredited lab. The exact-probability design and the tests (`test/markets.test.ts`) make that straightforward.
- **Free-to-play first.** Freeroll tournaments with a prize pool paid by the house are the lowest-risk way to launch and build an audience while the licence is in progress. Check local promotion/sweepstakes rules.

## Roadmap (suggested order)

1. **Pilot in our own club:** freeroll tournaments on one table, dual-confirm on, camera recording.
2. **Video:** low-latency stream per table (WebRTC or LL-HLS) in the `streamUrl` slot.
3. **Card recognition:** built: a camera over each table and AI flop reading (docs/CAMERA.md), with dealer confirmation or fully automatic entry. Next: run it at our tables, measure accuracy per table, then consider an RFID shoe for certification where a regulator requires it.
4. **Licence + payments + KYC** → real-money cash betting for direct players.
5. **First partner** on the seamless wallet; monthly invoices from Admin → Commission.
6. **More content:** more markets (exact card, flop total, turn/river), more tournament formats, partner-branded tables.
7. **Scale:** PostgreSQL is supported (set `DATABASE_URL`), so several app servers can share one database; money-moving transactions run SERIALIZABLE and retry on conflict. SQLite stays the simple single-server option.
