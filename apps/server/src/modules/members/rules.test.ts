import { describe, expect, it } from 'vitest';
import type { Role } from '../../db/schema/index.js';
import { playModeError, removeError, roleChangeError, type Party } from './rules.js';

const party = (id: string, roles: Role[], isAdmin = false): Party => ({ userId: id, roles, isAdmin });
const owner = party('o', ['owner']);
const manager = party('m', ['manager']);
const inspector = party('i', ['inspector']);
const dealer = party('d', ['dealer']);
const player = party('p', []);
const admin = party('a', [], true);

describe('roleChangeError (00 §3.3)', () => {
  it('rejects unknown roles first', () => {
    expect(roleChangeError(owner, player, 'boss', 'grant')).toBe('members.role_unknown');
  });

  it('never moves ownership through the role endpoints', () => {
    expect(roleChangeError(owner, player, 'owner', 'grant')).toBe('members.owner_transfer_only');
    expect(roleChangeError(owner, owner, 'owner', 'revoke')).toBe('members.owner_transfer_only');
    expect(roleChangeError(admin, player, 'owner', 'grant')).toBe('members.one_owner');
    expect(roleChangeError(admin, owner, 'owner', 'revoke')).toBe('members.last_owner');
  });

  it('lets a platform admin change any other role', () => {
    for (const role of ['manager', 'inspector', 'dealer'] as const) {
      expect(roleChangeError(admin, owner, role, 'grant')).toBeNull();
      expect(roleChangeError(admin, manager, role, 'revoke')).toBeNull();
    }
  });

  it('requires manager or higher', () => {
    expect(roleChangeError(inspector, player, 'dealer', 'grant')).toBe('members.forbidden');
    expect(roleChangeError(dealer, player, 'dealer', 'grant')).toBe('members.forbidden');
    expect(roleChangeError(player, player, 'dealer', 'grant')).toBe('members.forbidden');
  });

  it('allows only the dealer role on one\'s own card', () => {
    expect(roleChangeError(owner, owner, 'dealer', 'grant')).toBeNull();
    expect(roleChangeError(manager, manager, 'dealer', 'grant')).toBeNull();
    expect(roleChangeError(manager, manager, 'dealer', 'revoke')).toBeNull();
    expect(roleChangeError(owner, owner, 'manager', 'grant')).toBe('members.self_change');
    expect(roleChangeError(manager, manager, 'manager', 'revoke')).toBe('members.self_change');
    expect(roleChangeError(manager, manager, 'inspector', 'grant')).toBe('members.self_change');
  });

  it('lets the owner toggle manager, inspector and dealer on anyone', () => {
    for (const target of [manager, inspector, dealer, player]) {
      for (const role of ['manager', 'inspector', 'dealer'] as const) {
        expect(roleChangeError(owner, target, role, 'grant')).toBeNull();
        expect(roleChangeError(owner, target, role, 'revoke')).toBeNull();
      }
    }
  });

  it('keeps a manager below their own rank', () => {
    expect(roleChangeError(manager, player, 'manager', 'grant')).toBe('members.rank_too_high');
    expect(roleChangeError(manager, player, 'inspector', 'grant')).toBeNull();
    expect(roleChangeError(manager, dealer, 'inspector', 'grant')).toBeNull();
    expect(roleChangeError(manager, inspector, 'dealer', 'grant')).toBeNull();
    expect(roleChangeError(manager, inspector, 'inspector', 'revoke')).toBeNull();
    expect(roleChangeError(manager, party('m2', ['manager']), 'dealer', 'grant')).toBe('members.target_outranks');
    expect(roleChangeError(manager, owner, 'dealer', 'grant')).toBe('members.target_outranks');
    expect(roleChangeError(manager, party('x', ['manager', 'dealer']), 'dealer', 'revoke')).toBe('members.target_outranks');
  });
});

describe('removeError', () => {
  it('never removes oneself', () => {
    expect(removeError(manager, manager)).toBe('members.self_change');
  });
  it('requires manager or higher', () => {
    expect(removeError(inspector, player)).toBe('members.forbidden');
  });
  it('lets the owner remove anyone else and a manager only lower ranks', () => {
    expect(removeError(owner, manager)).toBeNull();
    expect(removeError(manager, inspector)).toBeNull();
    expect(removeError(manager, player)).toBeNull();
    expect(removeError(manager, party('m2', ['manager']))).toBe('members.target_outranks');
    expect(removeError(manager, owner)).toBe('members.target_outranks');
  });
  it('never removes the owner, even for an admin', () => {
    expect(removeError(admin, owner)).toBe('members.last_owner');
    expect(removeError(admin, manager)).toBeNull();
  });
});

describe('playModeError', () => {
  it('requires manager or higher', () => {
    expect(playModeError(inspector, player)).toBe('members.forbidden');
  });
  it('allows oneself, the owner on anyone, and a manager on lower ranks', () => {
    expect(playModeError(manager, manager)).toBeNull();
    expect(playModeError(owner, manager)).toBeNull();
    expect(playModeError(manager, dealer)).toBeNull();
    expect(playModeError(manager, party('m2', ['manager']))).toBe('members.target_outranks');
    expect(playModeError(admin, owner)).toBeNull();
  });
});
