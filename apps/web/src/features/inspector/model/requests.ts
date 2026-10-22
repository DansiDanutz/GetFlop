/** Requests page logic: pending groups, badge count, history labels. Pure (tested). */

export interface PointsRequest {
  id: string;
  userId: string;
  kind: 'load' | 'cashout';
  amountCents: number;
  status: string;
  createdAt: string;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  username: string;
  displayName: string | null;
  /** Present when the server sends the player's current balance. */
  balanceCents?: number;
}

export interface JoinRequest { membershipId: string; userId: string; username: string; displayName: string | null; createdAt: string; via?: string }

export interface DealerSit { id: string; tableId: string; tableName: string; dealerId: string; dealerName: string; createdAt: string }

export interface PendingRequests { reloads: PointsRequest[]; cashouts: PointsRequest[]; dealerSits?: DealerSit[]; myStock: number | null }

export type GroupKey = 'points_in' | 'points_out' | 'join' | 'dealer_sit';

export type PendingItem =
  | { group: 'points_in' | 'points_out'; id: string; createdAt: string; request: PointsRequest }
  | { group: 'join'; id: string; createdAt: string; join: JoinRequest }
  | { group: 'dealer_sit'; id: string; createdAt: string; sit: DealerSit };

const byOldest = <T extends { createdAt: string }>(a: T, b: T): number => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** Points in, Points out, Join requests, Dealer seat requests — oldest first, empty groups dropped. */
export function pendingGroups(p: PendingRequests | undefined, joins: readonly JoinRequest[] | undefined): { key: GroupKey; items: PendingItem[] }[] {
  const groups: { key: GroupKey; items: PendingItem[] }[] = [
    { key: 'points_in', items: [...(p?.reloads ?? [])].sort(byOldest).map((r) => ({ group: 'points_in' as const, id: r.id, createdAt: r.createdAt, request: r })) },
    { key: 'points_out', items: [...(p?.cashouts ?? [])].sort(byOldest).map((r) => ({ group: 'points_out' as const, id: r.id, createdAt: r.createdAt, request: r })) },
    { key: 'join', items: [...(joins ?? [])].sort(byOldest).map((j) => ({ group: 'join' as const, id: j.membershipId, createdAt: j.createdAt, join: j })) },
    { key: 'dealer_sit', items: [...(p?.dealerSits ?? [])].sort(byOldest).map((s) => ({ group: 'dealer_sit' as const, id: s.id, createdAt: s.createdAt, sit: s })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Nav badge: Points requests + join requests + dealer sit requests. */
export function badgeCount(p: PendingRequests | undefined, joins: readonly JoinRequest[] | undefined): number {
  return (p?.reloads.length ?? 0) + (p?.cashouts.length ?? 0) + (p?.dealerSits?.length ?? 0) + (joins?.length ?? 0);
}

/** A return the player's balance no longer covers (only known when the balance is sent). */
export function returnUncovered(r: PointsRequest): boolean {
  return r.kind === 'cashout' && typeof r.balanceCents === 'number' && r.balanceCents < r.amountCents;
}

/** An approval that the inspector's own stock cannot cover. */
export function stockShort(r: PointsRequest, myStock: number | null): boolean {
  return r.kind === 'load' && myStock !== null && myStock < r.amountCents;
}

export function historyLabels(item: PointsRequest): { typeKey: string; statusKey: string } {
  return {
    typeKey: item.kind === 'load' ? 'insp_req_type_load' : 'insp_req_type_cashout',
    statusKey: item.status === 'approved' ? 'insp_req_status_approved' : item.status === 'rejected' ? 'insp_req_status_rejected' : 'insp_req_status_waiting',
  };
}

export const playerName = (x: { displayName: string | null; username: string }): string => x.displayName ?? x.username;
