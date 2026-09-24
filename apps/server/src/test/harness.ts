import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../app.js';
import { DEFAULT_CONFIG, type AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { schemaDdl } from '../db/migrate.js';
import * as schema from '../db/schema/index.js';
import { seedBetTypes } from '../db/seed.js';
import type { Logger } from '../http/errors.js';
import { MemoryMailer } from '../mailer.js';
import { hashSecret } from '../modules/auth/crypto.js';
import { RecordingEvents } from '../realtime/events.js';

let ddl: Promise<string[]> | undefined;

/** Controllable clock for tests. */
export class TestClock {
  constructor(private current = new Date('2026-09-24T18:00:00Z')) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const silentLogger: Logger = { error: () => undefined, info: () => undefined };

export interface TestEnv {
  readonly ctx: AppContext;
  readonly db: Db;
  readonly events: RecordingEvents;
  readonly mailer: MemoryMailer;
  readonly clock: TestClock;
  readonly app: ReturnType<typeof createApp>;
  /** Base URL of the running test server (use with supertest's request(url)). */
  readonly url: string;
  readonly server: Server;
  /** A cookie-keeping HTTP client, signed in as `username` (created if missing). */
  login(username: string, opts?: { admin?: boolean; pin?: string }): Promise<Agent>;
  close(): Promise<void>;
}

export type Agent = TestAgent & { userId: string; username: string };

/** Fresh in-memory Postgres (PGlite) with the full schema and seeded markets. */
export async function createTestEnv(overrides: Partial<AppContext['config']> = {}): Promise<TestEnv> {
  ddl ??= schemaDdl();
  const client = new PGlite();
  await client.exec((await ddl).join(';\n'));
  const db = drizzle(client, { schema }) as unknown as Db;
  await seedBetTypes(db);
  const events = new RecordingEvents();
  const mailer = new MemoryMailer();
  const clock = new TestClock();
  const ctx: AppContext = {
    db, events, mailer, logger: silentLogger, now: clock.now,
    config: { ...DEFAULT_CONFIG, ...overrides },
  };
  const app = createApp(ctx);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function login(username: string, opts: { admin?: boolean; pin?: string } = {}): Promise<Agent> {
    const pin = opts.pin ?? '1234';
    const [existing] = await db.select().from(schema.users).where(eqUsername(username));
    const user = existing ?? (await db.insert(schema.users).values({
      username, displayName: username, pinHash: await hashSecret(pin),
      termsAcceptedAt: clock.now(), isPlatformAdmin: Boolean(opts.admin),
      email: `${username}@example.test`, emailVerifiedAt: clock.now(),
    }).returning())[0]!;
    const agent = request.agent(url) as Agent;
    const res = await agent.post('/api/auth/login').send({ username, pin });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${JSON.stringify(res.body)}`);
    return Object.assign(agent, { userId: user.id, username });
  }

  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
  };
  return { ctx, db, events, mailer, clock, app, url, server, login, close };
}

import { sql } from 'drizzle-orm';
const eqUsername = (username: string) => sql`lower(${schema.users.username}) = lower(${username})`;

/** Unwraps the { success, data } envelope and fails loudly on errors. */
export function ok<T = any>(res: request.Response): T {
  if (res.status >= 400 || !res.body?.success) {
    throw new Error(`Expected success, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data as T;
}

/** Returns the error code of a failed response. */
export function errCode(res: request.Response): string {
  return res.body?.error?.code ?? `status ${res.status}`;
}
