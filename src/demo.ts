// Local demo: fresh in-memory database with demo data (see seed.ts). Prints the links to open.
// Nothing is kept after you stop it.

import { createApp } from './app.ts';
import { seedDemo } from './seed.ts';

const port = Number(process.env.PORT ?? 4000);
const publicUrl = `http://localhost:${port}`;
const app = createApp({ dbFile: ':memory:', publicUrl, demo: true });
const { op, links } = seedDemo(app, publicUrl);

app.startBackground();
app.server.listen(port, () => {
  console.log(`
GetFlop demo running on ${publicUrl}

  Player "Alex"  (500.00 EUR): ${links[0]}
  Player "Maria" (500.00 EUR): ${links[1]}
  Sign-up player: ${publicUrl}/   demo / demo-pass (200.00 EUR), "Play now", or create your own account
  Dealer console: ${publicUrl}/dealer.html   dealer / dealer-demo-pass
  Supervisor:                                  floor / floor-demo-pass (can void rounds)
  Admin:          ${publicUrl}/admin.html    admin / admin-demo-pass

Operator API credentials for "House Club":
  apiKey ${op.apiKey}
  secret ${op.secret}
`);
});
process.on('SIGINT', () => { app.stop(); process.exit(0); });
