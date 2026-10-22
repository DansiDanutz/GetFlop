/**
 * Client mirror of the server's role-management rules (00-overview §3.3).
 * The server enforces them; the UI uses these to enable controls and explain why one is off.
 */
export type RoleName = 'owner' | 'manager' | 'inspector' | 'dealer';
export type ToggleRole = Exclude<RoleName, 'owner'>;

export interface Party {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly isAdmin?: boolean;
}

/** Why a control is disabled (maps to own_reason_<key>). */
export type BlockReason = 'own_card' | 'owner_sets_manager' | 'owner_only_member' | 'no_permission';
export interface Toggle { readonly allowed: boolean; readonly reason: BlockReason | null }

export const ROLE_RANK: Readonly<Record<RoleName, number>> = { owner: 4, manager: 3, inspector: 2, dealer: 1 };
export const TOGGLE_ROLES: readonly ToggleRole[] = ['manager', 'inspector', 'dealer'];
const MANAGER = ROLE_RANK.manager;
const INSPECTOR = ROLE_RANK.inspector;

export const rankOf = (roles: readonly string[]): number =>
  roles.reduce((max, r) => Math.max(max, ROLE_RANK[r as RoleName] ?? 0), 0);

export const sortRoles = (roles: readonly string[]): string[] =>
  [...roles].sort((a, b) => (ROLE_RANK[b as RoleName] ?? 0) - (ROLE_RANK[a as RoleName] ?? 0));

const isOwner = (p: Party) => p.roles.includes('owner');
const allow: Toggle = { allowed: true, reason: null };
const block = (reason: BlockReason): Toggle => ({ allowed: false, reason });

export function roleToggle(actor: Party, target: Party, role: ToggleRole): Toggle {
  if (actor.isAdmin) return allow;
  const rank = rankOf(actor.roles);
  if (rank < MANAGER) return block('no_permission');
  if (actor.userId === target.userId) return role === 'dealer' ? allow : block('own_card');
  if (isOwner(actor)) return allow;
  if (ROLE_RANK[role] >= rank) return block('owner_sets_manager');
  if (rankOf(target.roles) >= rank) return block('owner_only_member');
  return allow;
}

export function playModeToggle(actor: Party, target: Party): Toggle {
  if (actor.isAdmin) return allow;
  const rank = rankOf(actor.roles);
  if (rank < MANAGER) return block('no_permission');
  if (actor.userId === target.userId || isOwner(actor)) return allow;
  return rankOf(target.roles) < rank ? allow : block('owner_only_member');
}

export function canRemove(actor: Party, target: Party): boolean {
  if (isOwner(target) || actor.userId === target.userId) return false;
  if (actor.isAdmin || isOwner(actor)) return true;
  const rank = rankOf(actor.roles);
  return rank >= MANAGER && rankOf(target.roles) < rank;
}

export const canTransferOwnership = (actor: Party, target: Party): boolean =>
  isOwner(actor) && actor.userId !== target.userId;

export const canClaimOrSend = (actor: Party): boolean => Boolean(actor.isAdmin) || rankOf(actor.roles) >= INSPECTOR;

export const canStock = (actor: Party, target: Party): boolean =>
  (Boolean(actor.isAdmin) || rankOf(actor.roles) >= MANAGER) && target.roles.includes('inspector');

/** Owner and manager see member balances in the list. */
export const seesBalances = (actor: Party): boolean => Boolean(actor.isAdmin) || rankOf(actor.roles) >= MANAGER;
