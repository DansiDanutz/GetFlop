/**
 * Receipts and credit notes (Elorus in the original). GetFlop ships a no-op provider: orders are
 * marked "skipped" (no receipt) and documents are not available. A real provider plugs in with
 * setReceiptProvider() at startup, behind its own env configuration.
 */
export interface ReceiptOrder {
  readonly orderId: string;
  readonly clubName: string;
  readonly productName: string;
  readonly netCents: number;
  readonly vatCents: number;
  readonly totalCents: number;
  readonly country: string | null;
}

export interface ReceiptResult {
  /** issued | drafted | sending | error | needs_review | skipped | void */
  readonly status: string;
  readonly ref: string | null;
}

export interface ReceiptProvider {
  /** live | drafts | off */
  readonly mode: string;
  issue(order: ReceiptOrder): Promise<ReceiptResult>;
  creditNote(order: ReceiptOrder, refundId: string): Promise<ReceiptResult>;
  /** The PDF of an issued document, or null when there is none. */
  document(ref: string): Promise<Buffer | null>;
}

export const noopReceipts: ReceiptProvider = {
  mode: 'off',
  issue: async () => ({ status: 'skipped', ref: null }),
  creditNote: async () => ({ status: 'skipped', ref: null }),
  document: async () => null,
};

let provider: ReceiptProvider = noopReceipts;

export function setReceiptProvider(p: ReceiptProvider): void {
  provider = p;
}

export function receipts(): ReceiptProvider {
  return provider;
}
