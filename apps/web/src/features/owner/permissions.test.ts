import { describe, expect, it } from 'vitest';
import {
  canClaimOrSend, canRemove, canStock, canTransferOwnership, playModeToggle, rankOf, roleToggle, sortRoles, type Party,
} from './permissions';

const p = (userId: string, roles: string[] = [], isAdmin = false): Party => ({ userId, roles, isAdmin });
const owner = p('o', ['owner']);
const manager = p('m', ['manager']);
const inspector = p('i', ['inspector']);
const dealer = p('d', ['dealer']);
const player = p('x');
const admin = p('a', [], true);

describe('rankOf / sortRoles', () => {
  it('ranks owner > manager > inspector > dealer > player', () => {
    expect([owner, manager, inspector, dealer, player].map((x) => rankOf(x.roles))).toEqual([4, 3, 2, 1, 0]);
    expect(sortRoles(['dealer', 'owner', 'inspector'])).toEqual(['owner', 'inspector', 'dealer']);
  });
});

describe('roleToggle mirrors the server rules', () => {
  it('lets the owner toggle every role but owner on others', () => {
    for (const role of ['manager', 'inspector', 'dealer'] as const) {
      expect(roleToggle(owner, manager, role)).toEqual({ allowed: true, reason: null });
    }
  });
  it('allows only dealer on one\'s own card', () => {
    expect(roleToggle(owner, owner, 'dealer').allowed).toBe(true);
    expect(roleToggle(manager, manager, 'dealer').allowed).toBe(true);
    expect(roleToggle(owner, owner, 'manager')).toEqual({ allowed: false, reason: 'own_card' });
    expect(roleToggle(manager, manager, 'inspector')).toEqual({ allowed: false, reason: 'own_card' });
  });
  it('explains the manager limits', () => {
    expect(roleToggle(manager, player, 'manager')).toEqual({ allowed: false, reason: 'owner_sets_manager' });
    expect(roleToggle(manager, player, 'inspector').allowed).toBe(true);
    expect(roleToggle(manager, dealer, 'dealer').allowed).toBe(true);
    expect(roleToggle(manager, p('m2', ['manager']), 'dealer')).toEqual({ allowed: false, reason: 'owner_only_member' });
    expect(roleToggle(manager, owner, 'dealer')).toEqual({ allowed: false, reason: 'owner_only_member' });
  });
  it('refuses inspectors and lets admins change anything but ownership', () => {
    expect(roleToggle(inspector, player, 'dealer')).toEqual({ allowed: false, reason: 'no_permission' });
    expect(roleToggle(admin, owner, 'manager').allowed).toBe(true);
  });
});

describe('play mode, removal, transfer, Points', () => {
  it('play mode: self, owner on anyone, manager below', () => {
    expect(playModeToggle(manager, manager).allowed).toBe(true);
    expect(playModeToggle(owner, manager).allowed).toBe(true);
    expect(playModeToggle(manager, p('m2', ['manager']))).toEqual({ allowed: false, reason: 'owner_only_member' });
    expect(playModeToggle(inspector, player)).toEqual({ allowed: false, reason: 'no_permission' });
  });
  it('removal: never self or the owner; managers only below them', () => {
    expect(canRemove(owner, owner)).toBe(false);
    expect(canRemove(owner, manager)).toBe(true);
    expect(canRemove(manager, inspector)).toBe(true);
    expect(canRemove(manager, p('m2', ['manager']))).toBe(false);
    expect(canRemove(inspector, player)).toBe(false);
    expect(canRemove(admin, owner)).toBe(false);
    expect(canRemove(admin, player)).toBe(true);
  });
  it('transfer: owner viewing another member only', () => {
    expect(canTransferOwnership(owner, player)).toBe(true);
    expect(canTransferOwnership(owner, owner)).toBe(false);
    expect(canTransferOwnership(manager, player)).toBe(false);
    expect(canTransferOwnership(admin, player)).toBe(false);
  });
  it('Send Out / Claim Back for inspectors and up; stock for owner/manager on inspectors', () => {
    expect(canClaimOrSend(inspector)).toBe(true);
    expect(canClaimOrSend(dealer)).toBe(false);
    expect(canClaimOrSend(admin)).toBe(true);
    expect(canStock(manager, inspector)).toBe(true);
    expect(canStock(manager, player)).toBe(false);
    expect(canStock(inspector, inspector)).toBe(false);
  });
});
