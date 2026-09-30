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

  // Closes a billing period for one operator. Periods must follow each other without overlap.
  createInvoice(operatorId: string, fromInput: unknown, toInput: unknown, actor: string) {
    const op = this.db.get('SELECT * FROM operators WHERE id = ?', operatorId) ?? fail(404, 'OPERATOR_NOT_FOUND');
    const from = int(fromInput, 'from');
    const to = int(toInput, 'to');
    if (to <= from) fail(400, 'BAD_INPUT', 'to must be after from');
    if (to > this.now()) fail(400, 'PERIOD_NOT_OVER', 'Only past periods can be invoiced');
    const last = this.db.get('SELECT * FROM invoices WHERE operator_id = ? ORDER BY period_to DESC LIMIT 1', operatorId);
    if (last && from < last.period_to) fail(409, 'PERIOD_OVERLAP', `Last invoice ends at ${last.period_to}`);

    const totals = this.report(from, to, operatorId).find((r) => r.currency === op.currency) ?? { bets: 0, stakes: 0, payouts: 0, ggr: 0 };
    const carryIn = last?.carry_out ?? 0;
    const base = totals.ggr + carryIn;
    const commission = base > 0 ? Math.floor((base * op.commission_bps) / 10_000) : 0;
    const carryOut = base < 0 ? base : 0;
    const id = newId('inv');
    this.db.run(
      `INSERT INTO invoices (id, operator_id, currency, period_from, period_to, bets, stakes, payouts, ggr, carry_in, commission_base, commission_bps, commission, carry_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, operatorId, op.currency, from, to, totals.bets, totals.stakes, totals.payouts, totals.ggr, carryIn, Math.max(base, 0), op.commission_bps, commission, carryOut, this.now(),
    );
    this.audit.log(actor, 'invoice.create', { invoiceId: id, operatorId, from, to, ggr: totals.ggr, commission, carryOut });
    return this.invoice(id);
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
