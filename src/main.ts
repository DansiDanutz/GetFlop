// Starts GetFlop.
//   PORT            HTTP port (default 4000)
//   DB_FILE         SQLite file (default data/getflop.db)
//   PUBLIC_URL      base URL players reach, used in launch links (default http://localhost:PORT)
//   ADMIN_USERNAME / ADMIN_PASSWORD   creates the first admin on an empty database

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 4000);
const dbFile = process.env.DB_FILE ?? 'data/getflop.db';
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });

export const app = createApp({ dbFile, publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}` });
if (app.bootstrapAdmin(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD)) console.log(`Created admin "${process.env.ADMIN_USERNAME}"`);
if (!app.db.get('SELECT 1 FROM staff LIMIT 1')) console.warn('No staff accounts yet: restart with ADMIN_USERNAME and ADMIN_PASSWORD set.');

app.startBackground();
app.server.listen(port, () => console.log(`GetFlop listening on http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.stop(); process.exit(0); });
