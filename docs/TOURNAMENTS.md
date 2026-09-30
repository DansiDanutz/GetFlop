# Tournaments

Everyone in a tournament gets the same tournament points and plays them on real flops at any live table, at the same odds as cash bets. When the tournament ends, the leaderboard decides who shares the prize pool.

## What every tournament has (the engine, `src/tournaments.ts`)

- Name, start and end time. Statuses: scheduled → running → finishing → finished (or cancelled).
- **Buy-in** (0 = freeroll) in a currency, a **fee** % taken from the buy-ins, and an optional **guaranteed** prize pool. If buy-ins don't reach the guarantee, the house adds the difference (the overlay).
- Players join with one tap; the buy-in moves into the tournament's prize-pool account in the ledger.
- Tournament bets settle in the same database transaction as the real flop, so the leaderboard updates the moment the dealer confirms.
- A voided hand gives tournament points back, and the bet does not count against the bet limit.
- Bets placed before the end still count: the tournament waits in `finishing` until those hands are settled, then ranks and pays.
- If nobody qualifies, buy-ins are refunded. Cancelling refunds all buy-ins.

## What a strategy decides

A strategy is one object implementing `TournamentStrategy`:

| Method | Decides |
|---|---|
| `parseRules(input)` | which settings exist, their defaults and limits |
| `describe(rules)` | the "How it works" text players see |
| `startingPoints(rules)` | points each player starts with |
| `checkBet(rules, entry, stake)` | whether a bet is allowed (bet count, stake size…) |
| `qualifies(rules, entry)` | whether a player can win a prize |
| `compare(a, b)` | leaderboard order, ties included |
| `prizeSplit(rules, paidPlaces, pool)` | how the pool is shared |

To add a format, write the object, add it to `STRATEGIES`, and add a test. The admin screen lists every registered strategy.

## Strategy 1: Points race (`points_race`)

The example format:

> Each player gets points, anybody can bet 100 times in the next 8 hours, there is a prize pool and a leaderboard, and the top 5% take the winnings.

| Setting | Default |
|---|---|
| `startingPoints` | 1000 |
| `maxBets` | 100 |
| `minStake` / `maxStake` | 10 / all starting points |
| `minBetsToQualify` | 1 |
| `paidPercent` | 5 (top 5% of entrants, at least 1 place) |
| `payoutCurve` | `top_heavy` (1st : 2nd : 3rd = 1 : ½ : ⅓ …) or `flat` |
| `lateJoin` | true |

The duration is the tournament's start/end time (8 hours by default). Ranking: most points; on a tie, fewer bets used; then whoever joined first.

## Ideas for next strategies

Waiting for the owner's rules. The engine already supports formats like:

- **Survival:** fixed points, no re-entry; once you're out you're out; last players standing share the pool.
- **Streak:** longest run of correct flops wins.
- **Sit & Go:** starts when N players join, fixed number of hands.
- **Head-to-head:** two players, same hands, most points after N flops.
