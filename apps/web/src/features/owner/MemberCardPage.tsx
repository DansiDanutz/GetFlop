import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount, date } from '../../lib/format';
import { useSocketEvent } from '../../lib/socket';
import { StaffShell } from '../staff/StaffShell';
import { ownerApi } from './api';
import { Coupons, FigureTiles, Movements, WhereTheyPlay } from './CardFigures';
import { browserTimeZone, periodRange, type CardPeriod } from './logic';
import { Avatar, RoleBadges } from './parts';
import { canClaimOrSend, canStock } from './permissions';
import { PointsMoveSheet, type MoveKind } from './PointsMoveSheet';
import { RoleControls } from './RoleControls';
import { useStaffClub } from './useStaffClub';
import './owner.css';

/** Member card (#/club/card/:userId): figures, where they play, coupons, movements, management (04 §8, 08 §2.1). */
export function MemberCardPage() {
  const t = useT();
  const { userId = '' } = useParams();
  const { clubId, actor, base } = useStaffClub();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<CardPeriod>('all');
  const [move, setMove] = useState<MoveKind | null>(null);
  const range = periodRange(period);
  const card = useQuery({
    queryKey: ['owner', 'card', clubId, userId, period],
    queryFn: () => ownerApi.card(clubId!, userId, range ? { ...range, tz: browserTimeZone() } : null),
    enabled: Boolean(clubId && userId),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['owner'] });
  useSocketEvent('members:changed', refresh, [qc]);

  if (!clubId) return null;
  const m = card.data?.member;
  return (
    <StaffShell>
      <Link to={base.members} className="btn link" style={{ justifySelf: 'start' }}>← {t('own_members_title')}</Link>
      {card.isLoading && <Spinner />}
      {card.error && <div className="banner danger">{t('err_members_not_found')}</div>}
      {m && card.data && (
        <>
          <div className="card row">
            <Avatar name={m.displayName} large />
            <div className="grow" style={{ minWidth: 0 }}>
              <h2 className="truncate">{m.displayName}{m.userId === actor.userId && <span className="faint"> · {t('own_you')}</span>}</h2>
              <span className="faint">@{m.username} · {t('own_member_since', { date: date(m.joinedAt) })}</span>
              <RoleBadges roles={m.roles} watch={m.playMode === 'watch'} />
            </div>
          </div>
          <div className="grid-2">
            <div className="tile"><span className="label">{t('own_balance_for_play')}</span><span className="value">{amount(m.balanceCents)}</span></div>
            {m.stockCents !== undefined && (
              <div className="tile"><span className="label">{t('own_stock_for_sending')}</span><span className="value">{amount(m.stockCents)}</span></div>
            )}
          </div>
          {m.roles.length > 0 && !m.roles.includes('owner') && <p className="own-note">{t('own_staff_no_play')}</p>}
          {canClaimOrSend(actor) && (
            <div className="grid-2">
              <button type="button" className="btn primary" onClick={() => setMove('send')}>{t('own_send_out')}</button>
              <button type="button" className="btn ghost" onClick={() => setMove('claim')} disabled={m.balanceCents <= 0}>{t('own_claim_back')}</button>
            </div>
          )}
          {canStock(actor, m) && (
            <div className="grid-2">
              <button type="button" className="btn outline-gold" onClick={() => setMove('give')}>{t('own_give_stock')}</button>
              <button type="button" className="btn ghost" onClick={() => setMove('take')} disabled={(m.stockCents ?? 0) <= 0}>{t('own_take_stock')}</button>
            </div>
          )}
          <FigureTiles f={card.data.stats.period} period={period} onPeriod={setPeriod} />
          <WhereTheyPlay markets={card.data.markets} />
          <Coupons clubId={clubId} userId={userId} />
          <Movements rows={card.data.movements} />
          <RoleControls clubId={clubId} actor={actor} member={m} membersPath={base.members} onChanged={refresh} />
          {move && (
            <PointsMoveSheet open kind={move} clubId={clubId} member={m} onClose={() => setMove(null)} onDone={refresh} />
          )}
        </>
      )}
    </StaffShell>
  );
}
