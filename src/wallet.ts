// Seamless wallet: for operators who keep player money in their own system. GetFlop calls the
// operator's wallet endpoints, signed with the operator's secret:
//   POST {walletUrl}/debit     take a stake            -> 200 { balance } | 402 { error: "INSUFFICIENT_FUNDS" }
//   POST {walletUrl}/credit    pay a win or a refund   -> 200 (must be idempotent on txId)
//   POST {walletUrl}/rollback  undo a debit we could not confirm (timeout) -> 200 (idempotent)
//   POST {walletUrl}/balance   read a balance          -> 200 { balance }
// Credits and rollbacks go through the outbox: they are written in the same database
// transaction as the settlement and retried until the operator acknowledges them. Retrying
// never stops (a win or refund is owed until it is delivered); after ALERT_AFTER attempts the
// message is flagged to admins, who can also force an immediate retry.

import type { Db } from './db.ts';
import type { Audit } from './audit.ts';
import { newId, signPayload } from './util.ts';

export type OperatorRow = {
  id: string; name: string; currency: string; wallet_mode: 'transfer' | 'seamless'; wallet_url: string | null;
  api_key: string; secret: string; commission_bps: number; status: string;
};

export type WalletResult =
  | { ok: true; balance?: number }
  | { ok: false; code: string; uncertain: boolean }; // uncertain: we don't know if the operator applied it

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 3_000;
const ALERT_AFTER = 25;
const MAX_BACKOFF_MS = 600_000;

export class SeamlessWallet {
  private db: Db;
  private audit: Audit;
  private now: () => number;
  private fetchFn: FetchFn;

  constructor(db: Db, audit: Audit, now: () => number, fetchFn: FetchFn = fetch as unknown as FetchFn) {
    this.db = db;
    this.audit = audit;
    this.now = now;
    this.fetchFn = fetchFn;
  }

  async call(op: OperatorRow, action: string, payload: Record<string, unknown>): Promise<WalletResult & { body?: any }> {
    if (!op.wallet_url) return { ok: false, code: 'WALLET_NOT_CONFIGURED', uncertain: false };
    const url = new URL(action, op.wallet_url.endsWith('/') ? op.wallet_url : op.wallet_url + '/');
    const body = JSON.stringify(payload);
    const ts = String(this.now());
    try {
      const res = await this.fetchFn(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-getflop-timestamp': ts,
          'x-getflop-signature': signPayload(op.secret, ts, 'POST', url.pathname, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON reply */ }
      if (res.status >= 200 && res.status < 300) return { ok: true, balance: parsed.balance, body: parsed };
      // A clear 4xx means the operator refused; a 5xx may or may not have been applied.
      return { ok: false, code: parsed.error ?? `HTTP_${res.status}`, uncertain: res.status >= 500 };
    } catch (e: any) {
      return { ok: false, code: e?.name === 'TimeoutError' ? 'WALLET_TIMEOUT' : 'WALLET_UNREACHABLE', uncertain: true };
    }
  }

  enqueue(operatorId: string, action: 'credit' | 'rollback', payload: Record<string, unknown>) {
    this.db.run(
      'INSERT INTO outbox (id, operator_id, action, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('ob'), operatorId, action, JSON.stringify(payload), this.now(), this.now(),
    );
  }

  // Messages that have not been acknowledged after many attempts, for the admin screen.
  stuck() {
    return this.db.all("SELECT * FROM outbox WHERE status = 'pending' AND attempts >= ? ORDER BY created_at LIMIT 200", ALERT_AFTER);
  }

  // Admin action once the partner says their wallet is back: try now instead of waiting for backoff.
  retryNow(operatorId?: string) {
    const res = operatorId
      ? this.db.run("UPDATE outbox SET next_attempt_at = ? WHERE status = 'pending' AND operator_id = ?", this.now(), operatorId)
      : this.db.run("UPDATE outbox SET next_attempt_at = ? WHERE status = 'pending'", this.now());
    return { scheduled: Number(res.changes) };
  }

  // Delivers due outbox messages. Backoff: 2s, 4s, 8s ... capped at 10 minutes.
  async deliverDue(limit = 50) {
    const due = this.db.all(
      `SELECT o.*, p.name, p.currency, p.wallet_mode, p.wallet_url, p.api_key, p.secret, p.commission_bps, p.status AS op_status
       FROM outbox o JOIN operators p ON p.id = o.operator_id
       WHERE o.status = 'pending' AND o.next_attempt_at <= ? ORDER BY o.created_at LIMIT ?`,
      this.now(), limit,
    );
    let delivered = 0;
    for (const row of due) {
      const op = { ...row, id: row.operator_id, status: row.op_status } as OperatorRow;
      const res = await this.call(op, row.action, JSON.parse(row.payload));
      const attempts = row.attempts + 1;
      if (res.ok) {
        this.db.run("UPDATE outbox SET status = 'done', attempts = ?, last_error = NULL WHERE id = ?", attempts, row.id);
        delivered++;
      } else {
        if (attempts === ALERT_AFTER)
          this.audit.log('system', 'outbox.stuck', { outboxId: row.id, operatorId: row.operator_id, action: row.action, error: res.code });
        const delay = Math.min(2_000 * 2 ** Math.min(attempts - 1, 20), MAX_BACKOFF_MS);
        this.db.run('UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', attempts, res.code, this.now() + delay, row.id);
      }
    }
    return delivered;
  }
}
