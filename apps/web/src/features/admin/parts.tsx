import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { amount, signed } from '../../lib/format';
import { errorMessage, hasKey, t as translate, useT } from '../../i18n/i18n';
import { Empty, Spinner } from '../../components/ui';
import { PERIOD_PRESETS, type PeriodPreset } from './logic';

/** Points of one club (never summed across clubs). */
export function Pts({ cents, sign = false, unit = 'points' }: { cents: number; sign?: boolean; unit?: string }) {
  const cls = sign && cents < 0 ? 'neg' : sign && cents > 0 ? 'pos' : undefined;
  return <span className={cls}>{sign ? signed(cents, unit) : amount(cents, unit)}</span>;
}

export function PeriodChips({ value, onChange }: { value: PeriodPreset; onChange: (p: PeriodPreset) => void }) {
  const t = useT();
  return (
    <div className="chips" role="tablist">
      {PERIOD_PRESETS.map((p) => (
        <button key={p} type="button" role="tab" aria-selected={p === value} className={`chip ${p === value ? 'on' : ''}`}
          onClick={() => onChange(p)}>{t(`admin_period_${p}`)}</button>
      ))}
    </div>
  );
}

/** Loading, error and empty handling around a query result. */
export function Loadable<T>({ query, empty, children }: {
  query: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown };
  empty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const t = useT();
  if (query.isLoading) return <Spinner />;
  if (query.error) {
    return (
      <div className="banner danger stack">
        <span>{errorText(query.error, t)}</span>
        <button type="button" className="btn ghost" onClick={() => void query.refetch()}>{t('retry')}</button>
      </div>
    );
  }
  if (query.data === undefined) return null;
  if (empty?.(query.data)) return <Empty title={t('admin_nothing_here')} />;
  return <>{children(query.data)}</>;
}

export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === 'not_found');
}

function errorText(err: unknown, t: (k: string) => string): string {
  if (isMissingEndpoint(err)) return t('admin_not_available');
  return err instanceof ApiError ? errorMessage(err.code, err.params) : t('err_generic');
}

export function Section({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="stack">
      <div className="row-between"><h2 className="section-title">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

/** Translation for a server-provided value (ledger kind, device …), or the raw value when there is no key. */
export function labelOr(key: string, raw: string): string {
  return hasKey(key) ? translate(key) : raw;
}

/** Runs an admin mutation: busy flag, success toast, error toast, then refreshes every admin query. */
export function useAdminAction() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>, success?: string | ((result: T) => string)): Promise<T | undefined> {
    setBusy(true);
    try {
      const result = await fn();
      if (success) toast.show(typeof success === 'function' ? success(result) : success, 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      return result;
    } catch (err) {
      toast.error(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}
