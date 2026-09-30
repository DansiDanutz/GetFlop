// Vercel entry point. Vercel runs the app as a function: no long-running server and no disk.
// Static screens in public/ are served by Vercel directly; /v1/* is rewritten here (see
// vercel.json). Node runs the TypeScript sources natively.
//
// With DATABASE_URL set (a PostgreSQL connection string, e.g. Supabase), every copy of the
// function shares one database: data persists and all visitors see the same tables. The demo
// data is seeded once, on the first start against an empty database. Without it, each copy
// keeps its own in-memory demo that resets whenever Vercel recycles the function.

import { createApp } from '../src/app.ts';
import { ensureDemoTournament, seedDemo, seedDemoOnce } from '../src/seed.ts';

const publicUrl = process.env.PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
const databaseUrl = process.env.DATABASE_URL;

let ready = null;
let lastTournamentCheck = 0;
function start() {
  ready ??= (async () => {
    const app = await createApp({ dbFile: databaseUrl || ':memory:', publicUrl, demo: true, tickOnRequest: true });
    if (databaseUrl) {
      await seedDemoOnce(app, publicUrl);
      await ensureDemoTournament(app);
    } else {
      await seedDemo(app, publicUrl);
    }
    return app;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await start();
  } catch (e) {
    console.error('startup failed', e);
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'STARTING', message: 'Database unavailable, try again shortly' }));
    return;
  }
  if (databaseUrl && Date.now() - lastTournamentCheck > 60_000) {
    lastTournamentCheck = Date.now();
    await ensureDemoTournament(app).catch((e) => console.error('demo tournament check failed', e));
  }
  app.server.emit('request', req, res);
}
