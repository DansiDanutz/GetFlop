import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { DEFAULT_CONFIG, type AppContext } from './context.js';
import { openDatabase } from './db/client.js';
import { pushSchema } from './db/migrate.js';
import { seedBetTypes } from './db/seed.js';
import { consoleLogger } from './http/errors.js';
import { MemoryMailer } from './mailer.js';
import { startBackgroundJobs, socketExtensions } from './modules/jobs.js';
import { SocketEvents, createIo } from './realtime/io.js';

const port = Number(process.env.PORT ?? 4000);
const pgliteDir = process.env.PGLITE_DIR ?? './data/pglite';
if (!process.env.DATABASE_URL) mkdirSync(pgliteDir, { recursive: true });

const handle = await openDatabase({ url: process.env.DATABASE_URL || undefined, pgliteDir });
await pushSchema(handle.db);
await seedBetTypes(handle.db);

const events = new SocketEvents();
const webOrigin = process.env.WEB_ORIGIN ?? DEFAULT_CONFIG.webOrigin;
const ctx: AppContext = {
  db: handle.db,
  events,
  logger: consoleLogger,
  mailer: new MemoryMailer(consoleLogger),
  now: () => new Date(),
  config: {
    ...DEFAULT_CONFIG,
    webOrigin,
    publicAppUrl: process.env.PUBLIC_APP_URL ?? webOrigin,
    secureCookies: process.env.NODE_ENV === 'production',
    bettingTimerSeconds: Number(process.env.BETTING_TIMER_SECONDS ?? DEFAULT_CONFIG.bettingTimerSeconds),
  },
};

const http = createServer(createApp(ctx));
events.attach(createIo(http, ctx, socketExtensions));
const stopJobs = startBackgroundJobs(ctx);
http.listen(port, () => consoleLogger.info(`GetFlop server on http://localhost:${port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopJobs();
    http.close(() => void handle.close().then(() => process.exit(0)));
  });
}
