import type { Role } from '../../db/schema/index.js';
import { highestRank, ROLE_RANK } from '../clubs/access.js';

/**
 * Role-management rules (00-overview §3.3), as pure functions returning the
 * error code that blocks an action, or null when it is allowed.
 */
export interface Party {
  readonly userId: string;
  readonly roles: readonly Role[];
  readonly isAdmin?: boolean;
}

export const MANAGEABLE_ROLES = ['manager', 'inspector', 'dealer'] as const;
export type ManageableRole = (typeof MANAGEABLE_ROLES)[number];
export type RoleChange = 'grant' | 'revoke';

const MANAGER_RANK = ROLE_RANK.manager;

export const isKnownRole = (role: string): role is Role => role in ROLE_RANK;

export function roleChangeError(actor: Party, target: Party, role: string, change: RoleChange): string | null {
  if (!isKnownRole(role)) return 'members.role_unknown';
  if (role === 'owner') {
    if (!actor.isAdmin) return 'members.owner_transfer_only';
    return change === 'grant' ? 'members.one_owner' : 'members.last_owner';
  }
  if (actor.isAdmin) return null;
  const actorRank = highestRank(actor.roles);
  if (actorRank < MANAGER_RANK) return 'members.forbidden';
  if (actor.userId === target.userId) return role === 'dealer' ? null : 'members.self_change';
  if (actor.roles.includes('owner')) return null;
  if (ROLE_RANK[role] >= actorRank) return 'members.rank_too_high';
  if (highestRank(target.roles) >= actorRank) return 'members.target_outranks';
  return null;
}

export function removeError(actor: Party, target: Party): string | null {
  if (target.roles.includes('owner') && actor.isAdmin) return 'members.last_owner';
  if (actor.isAdmin) return null;
  if (actor.userId === target.userId) return 'members.self_change';
  const actorRank = highestRank(actor.roles);
  if (actorRank < MANAGER_RANK) return 'members.forbidden';
  if (actor.roles.includes('owner')) return null;
  return highestRank(target.roles) < actorRank ? null : 'members.target_outranks';
}

export function playModeError(actor: Party, target: Party): string | null {
  if (actor.isAdmin) return null;
  const actorRank = highestRank(actor.roles);
  if (actorRank < MANAGER_RANK) return 'members.forbidden';
  if (actor.userId === target.userId || actor.roles.includes('owner')) return null;
  return highestRank(target.roles) < actorRank ? null : 'members.target_outranks';
}

/** Roles after a grant or revoke, highest first, without duplicates. */
export function nextRoles(current: readonly Role[], role: Role, change: RoleChange): Role[] {
  const set = new Set(current);
  if (change === 'grant') set.add(role);
  else set.delete(role);
  return [...set].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
}
