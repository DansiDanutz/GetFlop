// Vercel entry point. Vercel runs the app as a function (no long-running server, no disk), so
// this deployment is a DEMO: an in-memory database seeded with demo data that resets whenever
// Vercel recycles the function. Static screens in public/ are served by Vercel directly;
// /v1/* is rewritten here (see vercel.json). Node runs the TypeScript sources natively.

import { createApp } from '../src/app.ts';
import { seedDemo } from '../src/seed.ts';

const publicUrl = process.env.PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
const app = createApp({ dbFile: ':memory:', publicUrl, demo: true, tickOnRequest: true });
seedDemo(app, publicUrl);

export default function handler(req, res) {
  app.server.emit('request', req, res);
}
