import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { onboardingSeen } from '../../db/schema/index.js';
import type { AuthUser } from '../auth/session.js';
import { loadClubAccess } from '../clubs/access.js';

export const SCENARIOS = ['player', 'dealer', 'inspector', 'manager', 'owner'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export async function onboardingState(ctx: AppContext, user: AuthUser) {
  const rows = await ctx.db.select().from(onboardingSeen).where(eq(onboardingSeen.userId, user.id));
  const scenarios = Object.fromEntries(SCENARIOS.map((s) => [s, rows.filter((r) => r.scenario === s).map((r) => r.code)])) as Record<Scenario, string[]>;
  let staff = false;
  if (user.activeClubId) {
    const access = await loadClubAccess(ctx.db, user, user.activeClubId).catch(() => null);
    staff = Boolean(access?.membership && access.rank >= 2);
  }
  return { scenarios, staff };
}

export async function markSeen(ctx: AppContext, userId: string, scenario: Scenario, code: string): Promise<void> {
  await ctx.db.insert(onboardingSeen).values({ userId, scenario, code, seenAt: ctx.now() }).onConflictDoNothing();
}
