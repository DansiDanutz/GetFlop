// Double-entry ledger. Every money movement is one transaction whose entries sum to zero, so
// money is never created or lost by a bug: it can only move between accounts.
//
// Accounts (per currency):
//   player:<playerId>        a player's balance (transfer-wallet operators only)
//   operator:<operatorId>    counterparty for deposits/withdrawals (transfer wallet)
//   seamless:<operatorId>    counterparty for the operator's own wallet (seamless wallet)
//   escrow:<roundId>         stakes held while a round is in play; always 0 after settlement
//   ggr:<operatorId>         game result for that operator's players (stakes lost minus winnings paid)
//   tournament:<id>          a tournament's prize pool (buy-ins in, prizes out)
//   house:rake               tournament fees kept by GetFlop
//   house:overlay            money GetFlop adds when buy-ins don't cover a guaranteed prize pool
//   house:cashier            manual deposits/withdrawals for players who signed up directly

import type { Db } from './db.ts';
import { fail, newId } from './util.ts';

export type Entry = { account: string; amount: number };

// Accounts that may go negative. Everything else (players, escrow) must stay >= 0.
const MAY_BE_NEGATIVE = /^(operator|seamless|ggr|house):/;

export class Ledger {
  private db: Db;
  private now: () => number;

  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  async post(kind: string, ref: string | null, currency: string, entries: Entry[]): Promise<string> {
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    if (sum !== 0) throw new Error(`ledger tx ${kind} does not balance (${sum})`);
    if (entries.some((e) => !Number.isSafeInteger(e.amount))) throw new Error('ledger amounts must be integers');
    return this.db.tx(async () => {
      const id = newId('tx');
      await this.db.run('INSERT INTO ledger_tx (id, kind, ref, created_at) VALUES (?, ?, ?, ?)', id, kind, ref, this.now());
      for (const e of entries) {
        if (e.amount === 0) continue;
        await this.db.run('INSERT INTO ledger_entries (tx_id, account, currency, amount) VALUES (?, ?, ?, ?)', id, e.account, currency, e.amount);
        await this.db.run(
          `INSERT INTO balances (account, currency, balance) VALUES (?, ?, ?)
           ON CONFLICT (account, currency) DO UPDATE SET balance = balances.balance + excluded.balance`,
          e.account, currency, e.amount,
        );
        if (!MAY_BE_NEGATIVE.test(e.account) && (await this.balance(e.account, currency)) < 0)
          fail(402, 'INSUFFICIENT_FUNDS', 'Not enough balance');
      }
      return id;
    });
  }

  transfer(kind: string, ref: string | null, currency: string, from: string, to: string, amount: number): Promise<string> {
    return this.post(kind, ref, currency, [{ account: from, amount: -amount }, { account: to, amount }]);
  }

  findTx(kind: string, ref: string) {
    return this.db.get<{ id: string }>('SELECT id FROM ledger_tx WHERE kind = ? AND ref = ?', kind, ref);
  }

  async balance(account: string, currency: string): Promise<number> {
    return (await this.db.get<{ balance: number }>('SELECT balance FROM balances WHERE account = ? AND currency = ?', account, currency))?.balance ?? 0;
  }

  // Integrity check for the admin screen: cached balances must equal the sum of entries,
  // and the whole book must sum to zero in every currency.
  async verify() {
    const mismatched = await this.db.all(
      `SELECT b.account, b.currency, b.balance, COALESCE(SUM(e.amount), 0) AS computed
       FROM balances b LEFT JOIN ledger_entries e ON e.account = b.account AND e.currency = b.currency
       GROUP BY b.account, b.currency HAVING b.balance != COALESCE(SUM(e.amount), 0)`,
    );
    const totals = await this.db.all('SELECT currency, SUM(amount) AS total FROM ledger_entries GROUP BY currency HAVING SUM(amount) != 0');
    return { ok: mismatched.length === 0 && totals.length === 0, mismatched, unbalancedCurrencies: totals };
  }
}
