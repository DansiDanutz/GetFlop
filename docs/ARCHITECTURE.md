# GetFlop architecture and conventions

Read this before changing code. The functional spec is in `docs/spec/` (start with `00-overview.md`).

## Layout

```
packages/engine      Pure game logic (cards, markets, limits, coupon validation, settlement). No I/O. 100% tested.
apps/server          Express 5 + Socket.io + Drizzle ORM. PGlite (embedded Postgres) in dev/tests, Postgres via DATABASE_URL.
  src/db/schema/     core.ts (shared tables) + one file per module (messages.ts, tournaments.ts, arena.ts, commerce.ts, misc.ts)
  src/modules/<m>/   One folder per module: register.ts (routes), service.ts, *.test.ts
  src/modules/index.ts   Module registry (mount order)
  src/modules/jobs.ts    Background jobs + socket extensions (addJob / addSocketExtension)
  src/modules/game/      Tables, hands, coupons, settlement. Extension points: hooks.ts, funds.ts
  src/test/          harness.ts (createTestEnv, login, ok, errCode) and fixtures.ts (setupClub, addMember, grantRole)
apps/web             React 19 + Vite + React Query + socket.io-client. Hash routes (#/player, #/dealer …).
  src/features/<f>/  One folder per feature: routes.tsx (exports <f>Routes), screens, <f>.css
  src/i18n/locales/{en,el}/<f>.ts   One dictionary per feature (auto-merged). Never edit another feature's file.
  src/components/    Shared kit: PlayingCard/Flop/CardBack, CountdownRing, Sheet/ConfirmSheet, Toast, TopBar, ui.tsx
  src/lib/           api.ts (fetch wrapper, X-Club-Id), socket.ts (useSocketEvent, useTableRoom), format.ts
  src/state/session.tsx   useSession(): user, club context (roles, surfaces, capabilities), selectClub, logout
```

## Money

- All amounts are **integer cents of a Point** (`100` = 1 PTS). Tournament chips (TC) and Arena Stars use the same integer scale.
- Multipliers are stored ×100 (`230` = ×2.3). Payout = `floor(stake × multiplierX100 / 100)`, stake included.
- Points only move through `modules/points/ledger.ts` → `move()`: double-entry between accounts
  (`pool`, `player` wallet, `stock` inspector stock, `riding` live coupon commitments, `tournament` prize pools).
  Rows are append-only. Invariant checked by `supply()`: holdings − issued = 0.
- Coupons debit their whole commitment at placement (wallet → riding). Each settled pick moves its stake riding → pool and a win pays pool → wallet.
- Other units plug in with `registerFunds(unit, funds)` (see `game/funds.ts`): tournaments register `chips`, the Arena registers `stars`.

## Server rules

- **Never use `ctx.db` inside a transaction** — use the `tx` handle. PGlite has one connection; mixing deadlocks.
- Errors: `throw new AppError('module.reason', status, params)`. Codes are dotted; the web maps `a.b_c` → `err_a_b_c`.
  Use the codes from `docs/spec/15-error-codes.md` exactly.
- Responses: return plain data from `handle(async (req) => …)`; it is wrapped as `{ success: true, data }`.
- Validate every body/query with zod. Resolve the club with `requireClub(db, req, user, capability, clubId?)`
  (X-Club-Id header or the user's active club). Capabilities: see `clubs/access.ts`.
- Realtime: `ctx.events.emit(rooms.table(id) | rooms.club(id) | rooms.staff(id) | rooms.user(id), event, payload)`.
- Time: always `ctx.now()` (tests control the clock).
- Register hooks (`game/hooks.ts`), funds, jobs (`addJob`) and socket extensions (`addSocketExtension`) at the
  **top level** of your module's `register.ts` so they run once, not inside the registrar function.
- New tables go in your module's schema file under `src/db/schema/`. Changes to `core.ts` must be additive (new nullable
  columns or new tables only).

## Web rules

- Screens are mobile-first (375px wide), dark theme, big tap targets. Reuse classes from `styles/components.css`;
  feature-specific CSS goes in `features/<f>/<f>.css` imported by the feature.
- Every visible string goes through `useT()` with keys in your feature's dictionary (English and Greek).
- Data: React Query (`useQuery`, `useMutation`) + `api`. Live updates: `useSocketEvent(event, handler)` then invalidate queries.
- Show errors with `useToast().error(err)` — it translates the server code.

## Tests

- Server: `apps/server/src/**/*.test.ts` with `createTestEnv()` (fresh in-memory Postgres per test) and `setupClub()`.
  Assert on error codes with `errCode(res)` and on envelopes with `ok(res)`.
- Engine: pure unit tests. Web: Vitest + Testing Library for logic-heavy components.
- Run everything: `pnpm test`. Server only: `pnpm --filter @getflop/server test`.

## Run locally

```bash
pnpm install
pnpm --filter @getflop/server seed:demo   # demo club; accounts admin/owner/dealer/floor/alice/bob, PIN 1234
pnpm dev                                  # server :4000, web :5173
```
