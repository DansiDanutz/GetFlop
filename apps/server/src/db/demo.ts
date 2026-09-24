/**
 * Seeds a demo club you can sign in to (PIN 1234 for every account):
 *   admin (platform admin) · owner · dealer · floor (inspector) · alice · bob
 * Run: pnpm --filter @getflop/server seed:demo
 */
import { mkdirSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_CONFIG, type AppContext } from '../context.js';
import { consoleLogger } from '../http/errors.js';
import { MemoryMailer } from '../mailer.js';
import { hashSecret } from '../modules/auth/crypto.js';
import { loadClubAccess } from '../modules/clubs/access.js';
import { createClub } from '../modules/clubs/service.js';
import { createTable, openTable } from '../modules/game/tables.js';
import { mint, staffTransfer } from '../modules/points/service.js';
import { RecordingEvents } from '../realtime/events.js';
import { openDatabase } from './client.js';
import { pushSchema } from './migrate.js';
import { clubs, clubTables, memberships, users, type Role } from './schema/index.js';
import { seedBetTypes } from './seed.js';

const PIN = '1234';
const pgliteDir = process.env.PGLITE_DIR ?? './data/pglite';
if (!process.env.DATABASE_URL) mkdirSync(pgliteDir, { recursive: true });
const handle = await openDatabase({ url: process.env.DATABASE_URL || undefined, pgliteDir });
await pushSchema(handle.db);
await seedBetTypes(handle.db);
const ctx: AppContext = {
  db: handle.db, events: new RecordingEvents(), logger: consoleLogger, mailer: new MemoryMailer(),
  now: () => new Date(), config: DEFAULT_CONFIG,
};

async function user(username: string, displayName: string, admin = false) {
  const [existing] = await ctx.db.select().from(users).where(sql`lower(${users.username}) = ${username}`);
  if (existing) return existing;
  const [row] = await ctx.db.insert(users).values({
    username, displayName, pinHash: await hashSecret(PIN), isPlatformAdmin: admin,
    email: `${username}@demo.getflop.local`, emailVerifiedAt: new Date(), termsAcceptedAt: new Date(),
  }).returning();
  return row!;
}

await user('admin', 'Platform Admin', true);
const owner = await user('owner', 'Dan (Owner)');
const dealer = await user('dealer', 'Nikos (Dealer)');
const floor = await user('floor', 'Eleni (Floor)');
const alice = await user('alice', 'Alice');
const bob = await user('bob', 'Bob');

const [existingClub] = await ctx.db.select().from(clubs).where(eq(clubs.ownerId, owner.id));
const club = existingClub ?? await createClub(ctx, owner, { name: 'Sharks Imperial', description: 'Demo club', acceptClubTerms: true });
await ctx.db.update(clubs).set({ level: 'club500' }).where(eq(clubs.id, club.id));

const members: [typeof owner, Role[]][] = [[dealer, ['dealer']], [floor, ['inspector']], [alice, []], [bob, []]];
for (const [u, roles] of members) {
  await ctx.db.insert(memberships).values({ clubId: club.id, userId: u.id, roles, status: 'active', via: 'created', reviewedAt: new Date() })
    .onConflictDoNothing();
  await ctx.db.update(users).set({ activeClubId: club.id }).where(eq(users.id, u.id));
}

const access = await loadClubAccess(ctx.db, (await ctx.db.select().from(users).where(eq(users.id, owner.id)))[0]!, club.id);
const tables = await ctx.db.select().from(clubTables).where(eq(clubTables.clubId, club.id));
if (tables.length === 0) {
  const t1 = await createTable(ctx, access, { name: 'Table 1 · NLH', game: 'nlh' });
  await createTable(ctx, access, { name: 'Table 2 · PLO', game: 'plo' });
  await openTable(ctx, access, t1.id, dealer.id);
  await mint(ctx, access, 100_000, 'Demo opening');
  for (const p of [alice, bob]) await staffTransfer(ctx, access, p.id, 'load', 20_000, 'Demo');
}

consoleLogger.info(`Demo ready. Club "${club.name}" ID ${club.publicId}. Accounts: admin, owner, dealer, floor, alice, bob — PIN ${PIN}`);
await handle.close();
