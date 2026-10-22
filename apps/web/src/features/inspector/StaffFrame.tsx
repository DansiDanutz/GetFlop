import type { ReactNode } from 'react';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { useInspectorLive, useJoinRequests, usePending } from './api';
import { badgeCount } from './model/requests';
import './inspector.css';

/** StaffShell with the Requests badge, live refresh and the request toasts. */
export function StaffFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const { context } = useSession();
  const pending = usePending();
  const joins = useJoinRequests(context?.club.id);
  useInspectorLive((event) => {
    if (event === 'request:new' || event === 'join-request:new') toast.show(t('insp_toast_pending'));
    if (event === 'dealer-sit:new') toast.show(t('insp_toast_dealer_sit'));
  });
  const waiting = badgeCount(pending.data, joins.data) > 0;
  return <StaffShell dots={{ requests: waiting }}>{children}</StaffShell>;
}
