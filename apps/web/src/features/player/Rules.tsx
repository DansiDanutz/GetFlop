import { useNavigate } from 'react-router-dom';
import { Flop } from '../../components/PlayingCard';
import { TopBar } from '../../components/TopBar';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { multiplier } from '../../lib/format';
import { useCatalogue } from './data';
import { EXAMPLE_FLOPS, marketKey, RULE_GROUPS } from './markets';
import './player.css';

const COUPON_POINTS = ['amount', 'locked', 'fixed', 'cancelled', 'closed', 'tournament'] as const;

const ruleKey = (slug: string) => {
  if (slug.startsWith('pair-')) return 'player_rule_pair_specific';
  if (slug.startsWith('flush-')) return 'player_rule_flush_suit';
  return `player_rule_${slug.replace(/-/g, '_')}`;
};

/** #/player/rules: every market with its multiplier, win rule and example flops, then how coupons work. */
export function Rules() {
  const t = useT();
  const navigate = useNavigate();
  const q = useCatalogue();
  const prices = new Map((q.data?.betTypes ?? []).map((m) => [m.slug, m.multiplier]));

  return (
    <div className="screen">
      <TopBar subtitle={t('player_rules_title')} />
      <div className="screen-body">
        <div className="row-between">
          <h1>{t('player_rules_title')}</h1>
          <button type="button" className="btn link" onClick={() => navigate(-1)}>{t('player_back')}</button>
        </div>
        <p className="muted">{t('player_rules_intro')}</p>
        {q.isLoading && <Spinner />}
        {q.isError && <div className="banner danger">{t('player_rules_error')}</div>}
        {RULE_GROUPS.map((group) => {
          const slugs = group.slugs.filter((s) => prices.has(s));
          if (slugs.length === 0) return null;
          return (
            <section key={group.key} className="stack">
              <h3 className="section-title">{t(`player_rules_group_${group.key}`)}</h3>
              {group.key === 'pairs' && <p className="muted">{t('player_rule_pair_specific')}</p>}
              <div className="list card tight">
                {slugs.map((slug) => (
                  <div key={slug} className="list-row pl-rule">
                    <span className="grow stack" style={{ gap: 4 }}>
                      <strong>{t(marketKey(slug))}</strong>
                      {group.key !== 'pairs' && <span className="muted">{t(ruleKey(slug))}</span>}
                      <span className="row">
                        {(EXAMPLE_FLOPS[slug] ?? []).map((f) => <Flop key={f.join('')} cards={f} size="sm" />)}
                      </span>
                    </span>
                    <strong className="pl-rule-mult">{multiplier(prices.get(slug) ?? 0)}</strong>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        <section className="stack">
          <h3 className="section-title">{t('player_rules_coupon_title')}</h3>
          <ol className="stack pl-coupon-rules">
            {COUPON_POINTS.map((k) => <li key={k}>{t(`player_rules_coupon_${k}`)}</li>)}
          </ol>
        </section>
      </div>
    </div>
  );
}
