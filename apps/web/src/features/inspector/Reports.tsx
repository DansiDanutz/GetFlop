import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { AnalyticsView } from './reports/AnalyticsView';
import { ClubReportView } from './reports/ClubReportView';
import { HandsView } from './reports/HandsView';
import { LiveView } from './reports/LiveView';
import { ShiftReportView } from './reports/ShiftReportView';
import { StaffFrame } from './StaffFrame';

export type Segment = 'live' | 'hands' | 'analytics' | 'report' | 'club';
const ALL: readonly Segment[] = ['live', 'hands', 'analytics', 'report', 'club'];

/** Reports tab: Live · Hands · Analytics · Report · Club (Club for owner or manager). */
export function Reports() {
  const t = useT();
  const navigate = useNavigate();
  const { can } = useSession();
  const { segment = 'live' } = useParams();
  const segments = ALL.filter((s) => s !== 'club' || can('settings'));
  if (!segments.includes(segment as Segment)) return <Navigate to="/club/reports/live" replace />;
  const current = segment as Segment;
  return (
    <StaffFrame>
      <Segmented value={current} onChange={(s) => navigate(`/club/reports/${s}`)}
        options={segments.map((s) => ({ value: s, label: t(`insp_seg_${s}`) }))} />
      {current === 'live' && <LiveView />}
      {current === 'hands' && <HandsView />}
      {current === 'analytics' && <AnalyticsView />}
      {current === 'report' && <ShiftReportView />}
      {current === 'club' && <ClubReportView />}
    </StaffFrame>
  );
}
