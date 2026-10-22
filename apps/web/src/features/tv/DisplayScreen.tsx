import { useParams } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { CashTvView } from './CashTvView';
import { TournamentTvView } from './TournamentTvView';
import { TvEnded, TvShell } from './TvShell';
import type { CashTvData, TournamentTvData, TvKind } from './types';
import { useTvDisplay } from './useTvDisplay';

/** #/tv/<kind>/<displayToken>: the live display. */
export function DisplayScreen({ kind }: { kind: TvKind }) {
  const t = useT();
  const { token = '' } = useParams();
  const display = useTvDisplay(kind, token);
  if (display.ended) return <TvEnded reason={display.ended} onPairAgain={display.pairAgain} />;
  if (!display.data) {
    return (
      <TvShell className="tv-center">
        <Spinner />
        {display.error ? <p className="muted">{t('tv_load_failed')}</p> : null}
      </TvShell>
    );
  }
  return (
    <TvShell className={kind === 'cash' ? 'tv-cash' : 'tv-tournament'}>
      {kind === 'cash'
        ? <CashTvView data={display.data as CashTvData} connection={display.connection} reveal={display.reveal} offsetMs={display.offsetMs} />
        : <TournamentTvView data={display.data as TournamentTvData} connection={display.connection} reveal={display.reveal} />}
    </TvShell>
  );
}
