# Partner integration guide

For casinos, sportsbooks and clubs that want to offer GetFlop to their players. You keep your players and their money; GetFlop runs the game and invoices a share of the GGR your players generate.

## 1. What you get from us

An **API key** and a **secret** (Admin → Partners → Add partner). The secret signs every request in both directions. Keep it on your server only.

## 2. Signing requests

Every call to `/v1/operator/*` carries three headers:

| Header | Value |
|---|---|
| `x-api-key` | your API key |
| `x-timestamp` | current time in milliseconds since epoch (must be within 5 minutes of ours) |
| `x-signature` | hex HMAC-SHA256 of `timestamp.METHOD.path.body` with your secret |

`path` includes the query string exactly as sent (`/v1/operator/bets?from=0`). `body` is the exact JSON you send; it is empty for GET.

```js
import { createHmac } from 'node:crypto';

async function getflop(method, path, body) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Date.now());
  const sig = createHmac('sha256', SECRET).update(`${ts}.${method}.${path}.${raw}`).digest('hex');
  const res = await fetch(`https://api.getflop.example${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'x-timestamp': ts, 'x-signature': sig },
    body: raw || undefined,
  });
  return res.json();
}
```

Errors come back as `{ "error": "CODE", "message": "…" }` with a 4xx/5xx status.

## 3. Launching a player

```
POST /v1/operator/sessions
{ "playerId": "your-user-id", "displayName": "Nick", "tableId": "optional" }
→ { "token": "…", "expiresAt": 1759300000000, "launchUrl": "https://…/play.html#token=…" }
```

Open `launchUrl` in a new tab, a webview or an iframe. The player is created on first launch. Sessions last 12 hours.

## 4. Money: pick one wallet mode

### Transfer wallet (simplest)

You move money into GetFlop before play and out after. GetFlop holds the balance.

```
POST /v1/operator/players/deposit   { "playerId": "u1", "amount": 5000, "txId": "your-unique-id" }
POST /v1/operator/players/withdraw  { "playerId": "u1", "amount": 2000, "txId": "your-unique-id" }
POST /v1/operator/players/balance   { "playerId": "u1" }
```

Amounts are integers in minor units (cents). A repeated `txId` is applied once and returns the current balance, so retrying is always safe.

### Seamless wallet (players keep one balance, in your system)

You expose four endpoints under your `walletUrl`. We call them with the same signature scheme, using headers `x-getflop-timestamp` and `x-getflop-signature` (HMAC of `timestamp.POST.path.body`). **Verify the signature.**

| Call | Body | Reply |
|---|---|---|
| `POST {walletUrl}/debit` | `{ txId, playerId, amount, currency, roundId, betId, marketId }` | `200 { "balance": n }`, or `402 { "error": "INSUFFICIENT_FUNDS" }` |
| `POST {walletUrl}/credit` | `{ txId, playerId, amount, currency, roundId, betId, reason: "win" \| "refund" }` | `200` |
| `POST {walletUrl}/rollback` | `{ txId, originalTxId, playerId, amount, currency, betId }` | `200` (undo `originalTxId` if you applied it; if you never saw it, record it so a late debit is refused) |
| `POST {walletUrl}/balance` | `{ playerId, currency }` | `200 { "balance": n }` |

Rules:

- **Every call is idempotent on `txId`.** We retry credits and rollbacks until you answer 2xx (backoff from 2 s up to 10 min, 25 attempts, then it's flagged to our admins).
- Answer debits within **3 seconds**. On timeout we refuse the bet and send a rollback.
- A 4xx on debit means "refused" and nothing is retried. A 5xx or timeout means "unknown", so we send a rollback.

## 5. Reconciliation and reporting

```
GET /v1/operator/bets?from=<ms>&to=<ms>&limit=1000     every bet of your players, oldest first
GET /v1/operator/reports/ggr?from=<ms>&to=<ms>         stakes, payouts, GGR, commission estimate
GET /v1/operator/invoices                              issued invoices
GET /v1/operator/tables                                live tables for your lobby
POST /v1/operator/players/status { playerId, status: "blocked" | "active" }   responsible-gambling / fraud blocks
```

Bet statuses: `open` (in play), `won`, `lost`, `refunded` (hand voided), `rejected` (your wallet refused).

## 6. Commission

`GGR = stakes lost − winnings paid`, over settled bets. Commission = your agreed % of positive GGR. A negative period is carried into the next one and must be recovered before commission is due again. Invoices show the carry in and carry out.
