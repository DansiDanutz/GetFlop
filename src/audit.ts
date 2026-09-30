// Tamper-evident audit trail. Each record carries the hash of the previous one, so editing or
// deleting any past record (a flop, a void, a limit change) breaks the chain and shows up in verify().

import type { Db } from './db.ts';
import { sha256 } from './util.ts';

const GENESIS = '0'.repeat(64);

export class Audit {
  private db: Db;
  private now: () => number;

  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  log(actor: string, action: string, data: Record<string, unknown>) {
    const prev = this.db.get<{ hash: string }>('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
    const at = this.now();
    const body = JSON.stringify(data);
    const hash = sha256(`${prev}|${at}|${actor}|${action}|${body}`);
    this.db.run('INSERT INTO audit (at, actor, action, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)', at, actor, action, body, prev, hash);
  }

  list(limit = 100, action?: string) {
    const rows = action
      ? this.db.all('SELECT * FROM audit WHERE action = ? ORDER BY seq DESC LIMIT ?', action, limit)
      : this.db.all('SELECT * FROM audit ORDER BY seq DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  verify(): { ok: boolean; records: number; brokenAt?: number } {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.db.sql.prepare('SELECT * FROM audit ORDER BY seq').iterate() as Iterable<any>) {
      const expect = sha256(`${prev}|${r.at}|${r.actor}|${r.action}|${r.data}`);
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, records: n, brokenAt: r.seq };
      prev = r.hash;
      n++;
    }
    return { ok: true, records: n };
  }
}
