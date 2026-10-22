import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../../components/Toast';
import { Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, signed } from '../../../lib/format';
import { useSession } from '../../../state/session';
import { INSP } from '../api';
import { browserTz, pct, periodQuery, type PeriodChip } from '../model/reports';
import { PeriodPicker } from './HandsView';
import { downloadServerCsv, Kv, tone } from './parts';
import type { ClubReport } from './types';

/** Reports → Club: 30-day club report for owner or manager (07 §4.6). */
export function ClubReportView() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { context, can } = useSession();
  const [chip, setChip] = useState<PeriodChip>('30d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const tz = browserTz();
  const params = useMemo(() => ({ ...periodQuery(chip, new Date(), tz, custom), tz }), [chip, custom, tz]);
  const q = useQuery({ queryKey: [INSP, 'club-report', params], queryFn: () => api.get<ClubReport>(`/inspector/club-report${qs(params)}`) });
  const r = q.data;

  return (
    <div className="stack">
      <PeriodPicker chip={chip} onChip={setChip} custom={custom} onCustom={setCustom} />
      {q.isLoading && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {r && (
        <>
          <div className="row-between">
            <span className="section-title">{t('insp_club_results')}</span>
            <button type="button" className="chip" onClick={() => void downloadServerCsv('/inspector/club-report', params, context?.club.id ?? '', 'club-report.csv').catch((e) => toast.error(e))}>{t('insp_csv')}</button>
          </div>
          <section className="card">
            <Kv rows={[
              [t('insp_flops_dealt'), r.results.flops],
              [t('insp_played'), amount(r.results.playedCents)],
              [t('insp_won_by_players'), amount(r.results.paidCents)],
              [t('insp_club_result'), <span key="c" className={tone(r.results.resultCents)}>{signed(r.results.resultCents)} · {pct(r.results.holdPct)}</span>],
              [t('insp_still_riding', { n: r.results.ridingCoupons }), amount(r.results.ridingCents)],
            ]} />
          </section>
          <span className="section-title">{t('insp_players')}</span>
          <section className="card stack">
            <Kv rows={[[t('insp_players_active'), r.players.active], [t('insp_players_new'), r.players.new], [t('insp_players_returning'), r.players.returning]]} />
            <span className="eyebrow">{t('insp_top_players')}</span>
            <div className="list">
              {r.players.top.map((p, i) => (
                <button key={p.userId} type="button" className="list-row insp-rowbtn" onClick={() => navigate(`/club/card/${p.userId}`)}>
                  <span className="faint">{i + 1}</span>
                  <span className="grow">{p.name} <span className="faint">{t('insp_picks_n', { n: p.picks })}</span></span>
                  <span>{amount(p.playedCents)}</span>
                  <strong className={tone(p.resultCents)}>{signed(p.resultCents)}</strong>
                </button>
              ))}
            </div>
          </section>
          <span className="section-title">{t('insp_points_period')}</span>
          <section className="card stack">
            <Kv rows={[
              [t('insp_pts_issued'), amount(r.points.issuedCents)],
              [t('insp_pts_sent'), amount(r.points.sentCents)],
              [t('insp_pts_returned'), amount(r.points.returnedCents)],
              [t('insp_pts_into_coupons'), amount(r.points.intoCouponsCents)],
              [t('insp_won_by_players'), amount(r.points.wonCents)],
              [t('insp_pts_refunded'), amount(r.points.refundedCents)],
              [t('insp_trn_entries'), amount(r.points.tournamentEntriesCents)],
              [t('insp_trn_prizes'), amount(r.points.tournamentPrizesCents)],
              [t('insp_players_hold'), amount(r.points.playersHoldCents)],
              [t('insp_club_holds'), amount(r.points.clubHoldsCents)],
            ]} />
            <p className="faint">{t('insp_coupons_vs_played')}</p>
          </section>
          <span className="section-title">{t('insp_diamonds')}</span>
          <section className="card stack">
            <Kv rows={[[t('insp_play_charge_measured'), `${r.diamonds.measuredPlayD} D`]]} />
            {r.diamonds.pilot && <p className="faint">{t('insp_measured_not_charged')}</p>}
            {can('billing') && <button type="button" className="btn ghost" onClick={() => navigate('/club/account')}>{t('insp_club_account')}</button>}
          </section>
        </>
      )}
    </div>
  );
}
