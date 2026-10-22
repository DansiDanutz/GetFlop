import { useParams } from 'react-router-dom';
import { hasKey, t } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import type { Party } from './permissions';

export interface StaffClub {
  /** Club the screen acts on: the :clubId route param (admin) or the active club. */
  readonly clubId: string | null;
  readonly clubName: string;
  readonly actor: Party;
  /** True when a platform admin views a club they are not the active member of. */
  readonly adminView: boolean;
  /** Path prefix for links that must keep the admin's club param. */
  readonly base: { members: string; card: (userId: string) => string };
}

export function useStaffClub(): StaffClub {
  const { clubId: param } = useParams();
  const { user, context } = useSession();
  const clubId = param ?? context?.club.id ?? null;
  const own = !param || param === context?.club.id;
  const actor: Party = { userId: user?.id ?? '', roles: own ? context?.roles ?? [] : [], isAdmin: user?.role === 'admin' };
  return {
    clubId,
    clubName: own ? context?.club.name ?? '' : '',
    actor,
    adminView: Boolean(param) && !own,
    base: {
      members: param ? `/club/members/${param}` : '/club/members',
      card: (userId) => (param ? `/club/card/${param}/${userId}` : `/club/card/${userId}`),
    },
  };
}

/** Localized market name (player dictionary), falling back to the slug. */
export function marketLabel(slug: string): string {
  const key = `market_${slug.replace(/-/g, '_')}`;
  return hasKey(key) ? t(key) : slug;
}
