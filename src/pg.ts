// A small PostgreSQL client written from scratch on node:net / node:tls / node:crypto: TLS,
// SCRAM-SHA-256 (and cleartext/MD5) login, parameterised queries over the extended protocol,
// and conversion of numeric column types to JavaScript numbers. One connection, one query at a
// time; callers serialise access (see db.ts).
//
// Wire protocol reference: https://www.postgresql.org/docs/current/protocol-message-formats.html

import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export type PgConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: 'disable' | 'require' | 'verify'; // require = encrypted; verify = encrypted + certificate checked
};

export class PgError extends Error {
  code: string;
  detail?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.code = fields.C ?? 'XX000';
    this.detail = fields.D;
  }
}

export type PgResult = { rows: Record<string, any>[]; rowCount: number };

export function parseDatabaseUrl(url: string): PgConfig {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1) || 'postgres'),
    ssl: mode === 'disable' ? 'disable' : mode === 'verify-full' || mode === 'verify-ca' ? 'verify' : 'require',
  };
}

// Column types returned as numbers: int2, int4, int8, oid, float4, float8, numeric.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const BOOL_OID = 16;

type Message = { type: string; body: Buffer };

export class PgConnection {
  private socket!: Socket | TLSSocket;
  private buffer = Buffer.alloc(0);
  private waiters: { resolve: (m: Message) => void; reject: (e: Error) => void }[] = [];
  private queue: Message[] = [];
  private closed: Error | null = null;
  private config: PgConfig;

  constructor(config: PgConfig) {
    this.config = config;
  }

  static async connect(config: PgConfig) {
    const c = new PgConnection(config);
    await c.open();
    return c;
  }

  private async open() {
    const { host, port } = this.config;
    let socket: Socket | TLSSocket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect({ host, port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    if (this.config.ssl !== 'disable') {
      socket.write(Buffer.concat([int32(8), int32(80877103)]));
      const answer = await new Promise<Buffer>((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
      });
      if (answer[0] !== 0x53) throw new Error('The PostgreSQL server does not accept TLS connections');
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket, servername: isIP(host) ? undefined : host, rejectUnauthorized: this.config.ssl === 'verify' });
        t.once('secureConnect', () => resolve(t));
        t.once('error', reject);
      });
    }
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('error', (e: Error) => this.fail(e));
    socket.on('close', () => this.fail(new Error('PostgreSQL connection closed')));

    const params = Buffer.concat([cstr('user'), cstr(this.config.user), cstr('database'), cstr(this.config.database), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
    socket.write(Buffer.concat([int32(params.length + 8), int32(196608), params]));
    await this.authenticate();
    // Drain ParameterStatus / BackendKeyData until ReadyForQuery.
    for (;;) {
      const m = await this.next();
      if (m.type === 'Z') break;
      if (m.type === 'E') throw new PgError(parseFields(m.body));
    }
  }

  private async authenticate() {
    let scram: { nonce: string; clientFirstBare: string; serverSignature?: Buffer } | null = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'E') throw new PgError(parseFields(m.body));
      if (m.type !== 'R') throw new Error(`Unexpected message during login: ${m.type}`);
      const kind = m.body.readInt32BE(0);
      if (kind === 0) return; // AuthenticationOk
      if (kind === 3) {
        this.send('p', cstr(this.config.password));
      } else if (kind === 5) {
        const salt = m.body.subarray(4, 8);
        const inner = md5(this.config.password + this.config.user);
        this.send('p', cstr('md5' + md5(Buffer.concat([Buffer.from(inner), salt]))));
      } else if (kind === 10) {
        const mechanisms = m.body.subarray(4).toString('utf8').split('\0');
        if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`Unsupported SASL mechanisms: ${mechanisms.join(', ')}`);
        const nonce = randomBytes(18).toString('base64');
        const clientFirstBare = `n=*,r=${nonce}`;
        const first = Buffer.from(`n,,${clientFirstBare}`);
        scram = { nonce, clientFirstBare };
        this.send('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first]));
      } else if (kind === 11 && scram) {
        const serverFirst = m.body.subarray(4).toString('utf8');
        const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
        if (!attrs.r?.startsWith(scram.nonce)) throw new Error('SCRAM: server nonce does not extend the client nonce');
        const salted = pbkdf2Sync(this.config.password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = createHash('sha256').update(clientKey).digest();
        const clientFinalNoProof = `c=biws,r=${attrs.r}`;
        const authMessage = `${scram.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
        const signature = hmac(storedKey, authMessage);
        const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]));
        scram.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
        this.send('p', Buffer.from(`${clientFinalNoProof},p=${proof.toString('base64')}`));
      } else if (kind === 12 && scram?.serverSignature) {
        const v = Buffer.from(m.body.subarray(4).toString('utf8').replace(/^v=/, '').split(',')[0], 'base64');
        if (v.length !== scram.serverSignature.length || !timingSafeEqual(v, scram.serverSignature)) throw new Error('SCRAM: server signature mismatch');
      } else {
        throw new Error(`Unsupported PostgreSQL authentication method ${kind}`);
      }
    }
  }

  // Parameterised query (extended protocol, unnamed statement, text formats).
  async query(sql: string, params: unknown[] = []): Promise<PgResult> {
    const values = params.map(encodeParam);
    const bind = [cstr(''), cstr(''), int16(0), int16(values.length)];
    for (const v of values) bind.push(v === null ? int32(-1) : Buffer.concat([int32(v.length), v]));
    bind.push(int16(0));
    this.write([
      message('P', Buffer.concat([cstr(''), cstr(sql), int16(0)])),
      message('B', Buffer.concat(bind)),
      message('D', Buffer.concat([Buffer.from('P'), cstr('')])),
      message('E', Buffer.concat([cstr(''), int32(0)])),
      message('S', Buffer.alloc(0)),
    ]);
    return this.collect();
  }

  // Simple protocol: several statements, no parameters (schema setup, BEGIN/COMMIT).
  async exec(sql: string): Promise<void> {
    this.write([message('Q', cstr(sql))]);
    await this.collect();
  }

  private async collect(): Promise<PgResult> {
    let fields: { name: string; oid: number }[] = [];
    const rows: Record<string, any>[] = [];
    let rowCount = 0;
    let error: PgError | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case 'T': fields = parseRowDescription(m.body); break;
        case 'D': rows.push(parseDataRow(m.body, fields)); break;
        case 'C': {
          const tag = m.body.subarray(0, m.body.length - 1).toString();
          const n = Number(tag.split(' ').at(-1));
          if (Number.isFinite(n)) rowCount += n;
          break;
        }
        case 'E': error = new PgError(parseFields(m.body)); break;
        case 'Z':
          if (error) throw error;
          return { rows, rowCount };
        default: break; // ParseComplete, BindComplete, NoData, NoticeResponse, EmptyQueryResponse ...
      }
    }
  }

  async close() {
    try { this.write([message('X', Buffer.alloc(0))]); } catch { /* already closed */ }
    this.socket?.end();
  }

  get isClosed() {
    return this.closed !== null;
  }

  // ---------- framing ----------

  private send(type: string, body: Buffer) {
    this.write([message(type, body)]);
  }

  private write(parts: Buffer[]) {
    if (this.closed) throw this.closed;
    this.socket.write(Buffer.concat(parts));
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const m = { type: String.fromCharCode(this.buffer[0]), body: this.buffer.subarray(5, len + 1) };
      this.buffer = this.buffer.subarray(len + 1);
      if (m.type === 'N' || m.type === 'A') continue; // notices, notifications
      const w = this.waiters.shift();
      if (w) w.resolve(m); else this.queue.push(m);
    }
  }

  private next(): Promise<Message> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }
}

function encodeParam(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return Buffer.from(v ? 'true' : 'false');
  if (typeof v === 'number' || typeof v === 'bigint') return Buffer.from(String(v));
  return Buffer.from(String(v), 'utf8');
}

function parseRowDescription(body: Buffer) {
  const count = body.readInt16BE(0);
  const fields = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    const end = body.indexOf(0, o);
    const name = body.subarray(o, end).toString('utf8');
    o = end + 1;
    const oid = body.readInt32BE(o + 6);
    o += 18;
    fields.push({ name, oid });
  }
  return fields;
}

function parseDataRow(body: Buffer, fields: { name: string; oid: number }[]) {
  const count = body.readInt16BE(0);
  const row: Record<string, any> = {};
  let o = 2;
  for (let i = 0; i < count; i++) {
    const len = body.readInt32BE(o);
    o += 4;
    const f = fields[i];
    if (len === -1) { row[f.name] = null; continue; }
    const text = body.subarray(o, o + len).toString('utf8');
    o += len;
    row[f.name] = NUMERIC_OIDS.has(f.oid) ? Number(text) : f.oid === BOOL_OID ? text === 't' : text;
  }
  return row;
}

function parseFields(body: Buffer) {
  const out: Record<string, string> = {};
  let o = 0;
  while (o < body.length && body[o] !== 0) {
    const code = String.fromCharCode(body[o]);
    const end = body.indexOf(0, o + 1);
    out[code] = body.subarray(o + 1, end).toString('utf8');
    o = end + 1;
  }
  return out;
}

const cstr = (s: string) => Buffer.from(s + '\0', 'utf8');
function int32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function int16(n: number) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function message(type: string, body: Buffer) { return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]); }
const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const md5 = (s: string | Buffer) => createHash('md5').update(s).digest('hex');
