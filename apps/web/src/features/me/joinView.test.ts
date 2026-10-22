import { describe, expect, it } from 'vitest';
import type { TableCard } from './data';
import { joinView } from './JoinTable';

const card = (status: string, membershipStatus: string | null): TableCard => ({
  table: {
    id: 't1', name: 'Table 1', kind: 'cash', status, game: 'nlh', photoUrl: null, joinCode: 'AB12CD34',
    tournamentId: null, activeHandStatus: null, activeHandNumber: null,
  },
  club: { id: 'c1', publicId: '1234567', name: 'Sharks', description: null, photoUrl: null, memberCount: 3 },
  membershipStatus,
});

const base = { failed: false, signedIn: true, sent: false };

describe('joinView', () => {
  it('checks, then reports invalid or closed tables', () => {
    expect(joinView(undefined, base)).toBe('checking');
    expect(joinView(undefined, { ...base, failed: true })).toBe('invalid');
    expect(joinView(card('closed', 'active'), base)).toBe('closed');
  });

  it('asks signed-out visitors to sign in first', () => {
    expect(joinView(card('open', null), { ...base, signedIn: false })).toBe('signin');
  });

  it('sends members to the table and offers others a request', () => {
    expect(joinView(card('open', 'active'), base)).toBe('member');
    expect(joinView(card('open', 'pending'), base)).toBe('pending');
    expect(joinView(card('open', null), base)).toBe('request');
    expect(joinView(card('open', 'left'), base)).toBe('request');
    expect(joinView(card('open', null), { ...base, sent: true })).toBe('sent');
  });
});
