# GetFlop

A flop-prediction platform for live poker clubs: before the flop is dealt, the whole room picks what it will bring (Rainbow, a pair, an ace, a flush…) with club Points. A clean-room re-implementation of the FlopMe feature set, built to be changed.

## Layout

| Path | What |
|---|---|
| `packages/engine` | Pure game logic: cards, the 29 markets and their multipliers, table limits, coupon validation and settlement. No I/O. |
| `apps/server` | API + realtime (planned: Node, Express, Socket.io, Drizzle/Postgres). |
| `apps/web` | Player, dealer, floor, owner, admin and TV screens (planned: React + Vite). |
| `docs/spec` | Functional spec per module. |

## Develop

```bash
pnpm install
pnpm test
```

Amounts are integer cents of a Point (`100` = 1 PTS). Multipliers are verified against all 22,100 possible flops in `packages/engine/src/markets.test.ts`.
