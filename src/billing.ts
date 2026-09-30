// Commission: operators pay GetFlop a share of the GGR (gross gaming revenue = stakes lost minus
// winnings paid) their players generate. A losing period (negative GGR) is carried forward and
// offset against the next periods before any commission is due again, the usual revenue-share rule.

import type { Db } from './db.ts';
import type { Audit } from './audit.ts';
import { fail, int, newId } from './util.ts';

export class Billing {
  private db: Db;
  private audit: Audit;
  private now: () => number;

  constructor(db: Db, audit: Audit, now: () => number) {
    this.db = db;
    this.audit = audit;
    this.now = now;
  }

  // Settled bets only (won/lost). Refunded bets are neither revenue nor cost.
  report(from: number, to: number, operatorId?: string) {
    const rows = this.db.all(
      `SELECT b.operator_id, o.name, b.currency, o.commission_bps,
              COUNT(*) AS bets, COUNT(DISTINCT b.player_id) AS players,
              SUM(b.stake) AS stakes, SUM(b.payout) AS payouts
       FROM bets b JOIN operators o ON o.id = b.operator_id
       WHERE b.status IN ('won','lost') AND b.settled_at >= ? AND b.settled_at < ? ${operatorId ? 'AND b.operator_id = ?' : ''}
       GROUP BY b.operator_id, b.currency ORDER BY o.name`,
      ...(operatorId ? [from, to, operatorId] : [from, to]),
    );
    return rows.map((r) => {
      const ggr = r.stakes - r.payouts;
      return {
        operatorId: r.operator_id, operator: r.name, currency: r.currency, bets: r.bets, players: r.players,
        stakes: r.stakes, payouts: r.payouts, ggr, holdPct: r.stakes ? ggr / r.stakes : 0,
        commissionBps: r.commission_bps, commissionIfInvoiced: ggr > 0 ? Math.floor((ggr * r.commission_bps) / 10_000) : 0,
      };
    });
  }

  // Closes a billing period for one operator. Periods are contiguous: each one starts exactly
  // where the previous one ended (the first starts when the partner was created), so every
  // settled bet is billed exactly once. `from` may be omitted; if given it must match.
  // A period may not span a commission rate change: invoice up to the change first, so each
  // period is charged the rate that was agreed for it.
  createInvoice(operatorId: string, fromInput: unknown, toInput: unknown, actor: string) {
    const op = this.db.get('SELECT * FROM operators WHERE id = ?', operatorId) ?? fail(404, 'OPERATOR_NOT_FOUND');
    const last = this.db.get('SELECT * FROM invoices WHERE operator_id = ? ORDER BY period_to DESC LIMIT 1', operatorId);
    const from: number = last?.period_to ?? op.created_at;
    if (fromInput !== undefined && fromInput !== null && int(fromInput, 'from') !== from)
      fail(409, 'PERIOD_NOT_CONTIGUOUS', `The next invoice for this partner must start at ${from}`);
    const to = int(toInput, 'to');
    if (to <= from) fail(400, 'BAD_INPUT', `to must be after ${from}`);
    if (to > this.now()) fail(400, 'PERIOD_NOT_OVER', 'Only past periods can be invoiced');
    const change = this.db.get(
      'SELECT effective_from FROM commission_rates WHERE operator_id = ? AND effective_from > ? AND effective_from < ? ORDER BY effective_from LIMIT 1',
      operatorId, from, to,
    );
    if (change) fail(409, 'RATE_CHANGED_IN_PERIOD', `The commission rate changed at ${change.effective_from}. Invoice up to that time first.`);
    const bps: number = this.db.get(
      'SELECT bps FROM commission_rates WHERE operator_id = ? AND effective_from <= ? ORDER BY effective_from DESC, rowid DESC LIMIT 1',
      operatorId, from,
    )?.bps ?? op.commission_bps;

    const totals = this.report(from, to, operatorId).find((r) => r.currency === op.currency) ?? { bets: 0, stakes: 0, payouts: 0, ggr: 0 };
    const carryIn = last?.carry_out ?? 0;
    const base = totals.ggr + carryIn;
    const commission = base > 0 ? Math.floor((base * bps) / 10_000) : 0;
    const carryOut = base < 0 ? base : 0;
    const id = newId('inv');
    this.db.run(
      `INSERT INTO invoices (id, operator_id, currency, period_from, period_to, bets, stakes, payouts, ggr, carry_in, commission_base, commission_bps, commission, carry_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, operatorId, op.currency, from, to, totals.bets, totals.stakes, totals.payouts, totals.ggr, carryIn, Math.max(base, 0), bps, commission, carryOut, this.now(),
    );
    this.audit.log(actor, 'invoice.create', { invoiceId: id, operatorId, from, to, ggr: totals.ggr, commissionBps: bps, commission, carryOut });
    return this.invoice(id);
  }

  // When the next invoice for this partner would start (for the admin screen).
  nextInvoiceStart(operatorId: string): number {
    const op = this.db.get('SELECT created_at FROM operators WHERE id = ?', operatorId) ?? fail(404, 'OPERATOR_NOT_FOUND');
    return this.db.get('SELECT MAX(period_to) AS t FROM invoices WHERE operator_id = ?', operatorId)?.t ?? op!.created_at;
  }

  invoice(id: string) {
    return this.db.get('SELECT * FROM invoices WHERE id = ?', id) ?? fail(404, 'INVOICE_NOT_FOUND');
  }

  listInvoices(operatorId?: string) {
    return operatorId
      ? this.db.all('SELECT * FROM invoices WHERE operator_id = ? ORDER BY period_to DESC', operatorId)
      : this.db.all('SELECT * FROM invoices ORDER BY period_to DESC');
  }
}
