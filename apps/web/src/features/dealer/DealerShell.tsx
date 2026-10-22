import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { hasKey, useT } from '../../i18n/i18n';
import { useSocketEvent } from '../../lib/socket';
import { dealerKeys } from './api';
import './dealer.css';

export type SeatStatus = 'approved' | 'assigned' | 'rejected' | 'taken' | 'unseated';

interface SeatEvent {
  status: SeatStatus;
  tableId: string;
  tableName: string;
}

interface NoticeEvent {
  code: string;
  params?: Record<string, string | number>;
}

const SEAT_TOAST_KIND: Record<SeatStatus, 'success' | 'info' | 'error'> = {
  approved: 'success', assigned: 'success', rejected: 'error', taken: 'error', unseated: 'info',
};

/** notice codes map to notice_<code with . and - as _>. */
export function noticeKey(code: string): string {
  return `notice_${code.replace(/[.-]/g, '_')}`;
}

/** Seat changes and notices pushed to the dealer, on every dealer screen. */
function useDealerPushes(): void {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  useSocketEvent<SeatEvent>('dealer:seat', (e) => {
    const status = e?.status;
    if (!status || !(status in SEAT_TOAST_KIND)) return;
    toast.show(t(`dealer_seat_${status}`, { table: e.tableName }), SEAT_TOAST_KIND[status]);
    void qc.invalidateQueries({ queryKey: dealerKeys.all });
    if (status === 'approved' || status === 'assigned') navigate(`/dealer/table/${e.tableId}`);
    if (status === 'unseated') navigate('/dealer');
  }, [t, toast, qc, navigate]);

  useSocketEvent<NoticeEvent>('notice:new', (e) => {
    const key = noticeKey(e?.code ?? '');
    if (hasKey(key)) toast.show(t(key, e.params ?? {}), 'error');
    void qc.invalidateQueries({ queryKey: dealerKeys.notices });
  }, [t, toast, qc]);
}

export function DealerShell({ children }: { children: ReactNode }) {
  useDealerPushes();
  return <>{children}</>;
}

/** A one-time hint (welcome, coach marks) remembered on this device. */
export function useOnce(key: string): [boolean, () => void] {
  const [pending, setPending] = useState<boolean>(() => {
    try {
      const store = window.localStorage;
      return typeof store?.getItem === 'function' ? store.getItem(key) === null : false;
    } catch {
      return false;
    }
  });
  const done = useCallback(() => {
    setPending(false);
    try { window.localStorage.setItem(key, '1'); } catch { /* storage unavailable: shown again next visit */ }
  }, [key]);
  return [pending, done];
}
