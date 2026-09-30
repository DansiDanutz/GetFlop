# GetFlop

Live pre-flop betting on real poker hands. A dealer deals a real hand at a real table; before the flop hits the felt, anyone (in the room or at home) bets on what it will bring: rainbow, a pair, an ace, three in a row… The dealer taps the three flop cards and every bet is settled at once.

Two ways to play:

- **Cash**: bet money on a flop, paid at fixed odds.
- **Tournaments**: everyone gets the same points and plays them on live flops. The leaderboard at the end decides who shares the prize pool. Formats are pluggable ([docs/TOURNAMENTS.md](docs/TOURNAMENTS.md)).

Two ways to get players:

- **Direct**: anyone signs up on GetFlop.
- **Partners**: casinos, sportsbooks and clubs connect their players through the operator API and pay a commission on the revenue their players generate ([docs/INTEGRATION.md](docs/INTEGRATION.md)).

The business model, risk controls and what is still needed before real money are in [docs/BUSINESS.md](docs/BUSINESS.md).

## Built from scratch

No frameworks and no runtime dependencies. Everything runs on what ships with Node.js 22.18+: `node:http` for the API and Server-Sent Events for live updates, `node:sqlite` for storage, `node:crypto` for passwords, tokens and request signatures, and Node's native TypeScript support. The screens are plain HTML/CSS/JS.

## Run it

```bash
npm run demo     # in-memory demo with staff, a table, players and a tournament; prints the links
npm test         # 30 tests: pricing, ledger, rounds, risk limits, seating, wallets, API, commission, tournaments
npm run odds     # the price list: exact probabilities and odds at a given margin (npm run odds -- 300)
```

Production-style start (data kept in `data/getflop.db`):

```bash
ADMIN_USERNAME=owner ADMIN_PASSWORD='a-long-password' PUBLIC_URL=https://play.example.com npm start
```

With Docker (the database lives in the `getflop-data` volume; back it up):

```bash
docker build -t getflop .
docker run -d --name getflop -p 4000:4000 -v getflop-data:/app/data \
  -e ADMIN_USERNAME=owner -e ADMIN_PASSWORD='a-long-password' -e PUBLIC_URL=https://play.example.com getflop
```

On Vercel (demo): the repo deploys as-is. `vercel.json` serves `public/` as static files and sends `/v1/*` to `api/index.mjs`, which runs the app in **demo mode**: an in-memory database seeded with demo data (staff logins shown on the staff screens, a "Play now" button with play money). Vercel functions have no disk and no long-running process, so demo data resets whenever Vercel recycles the function. Real use needs a persistent server (above) or a hosted database.

Put it behind HTTPS (any reverse proxy, e.g. Caddy or nginx). Live updates use Server-Sent Events, so disable response buffering for `/v1/stream` and `/v1/tournaments/*/stream` if the proxy buffers.

| Screen | URL | Who |
|---|---|---|
| Sign up / log in | `/` | players |
| Play | `/play.html` | players (or partner launch links) |
| Dealer console | `/dealer.html` | dealers, supervisors |
| Admin | `/admin.html` | admins: tables, partners, players & cashier, tournaments, commission, audit |

## Code map

| File | What it does |
|---|---|
| `src/cards.ts` | Cards and all 22,100 possible flops |
| `src/markets.ts` | The bet menu; exact probabilities; odds at a margin |
| `src/game.ts` | Tables, seated players, rounds (open → closed → settled / void), bets, worst-flop risk limit |
| `src/ledger.ts` | Double-entry ledger: money only moves, never appears or disappears |
| `src/wallet.ts` | Seamless wallet calls to partners, with a retrying outbox |
| `src/accounts.ts` | Partners and request signing, players, sign-up, cashier, staff, sessions |
| `src/tournaments.ts` | Tournament engine and strategies (first: points race) |
| `src/billing.ts` | GGR reports and commission invoices with carry-forward |
| `src/audit.ts` | Hash-chained audit log |
| `src/http.ts`, `src/app.ts` | HTTP toolkit and the API routes |
| `public/` | Player, dealer and admin screens |
