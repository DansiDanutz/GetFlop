import { useSyncExternalStore } from 'react';

/**
 * Why this device was signed out (auth.session_ended / session.expired).
 * session.tsx reports it; the SessionEnded screen reads it.
 */
export interface SessionEndedInfo {
  readonly reason: string;
  readonly deviceLabel?: string | null;
}

let current: SessionEndedInfo | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

export function reportSessionEnded(params: Readonly<Record<string, string | number>> | undefined): void {
  const reason = typeof params?.reason === 'string' ? params.reason : 'other_device';
  const deviceLabel = typeof params?.deviceLabel === 'string' ? params.deviceLabel : null;
  current = { reason, deviceLabel };
  notify();
}

/** A 401 code that means "signed out for a reason the user should see". */
export function handleUnauthorized(code: string, params?: Readonly<Record<string, string | number>>): void {
  if (code === 'auth.session_ended') reportSessionEnded(params);
  else if (code === 'session.expired') reportSessionEnded({ reason: 'expired' });
}

export function clearSessionEnded(): void {
  current = null;
  notify();
}

export function useSessionEnded(): SessionEndedInfo | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

const DEVICES: ReadonlySet<string> = new Set(['android', 'iphone', 'ipad', 'windows', 'mac', 'linux']);

export interface EndedCopy { readonly title: string; readonly body: string; readonly device: string | null }

/** Dictionary keys for the screen: another device (named when known), PIN changed, deleted, expired. */
export function endedCopy(info: SessionEndedInfo): EndedCopy {
  switch (info.reason) {
    case 'pin_change':
    case 'pin_reset':
      return { title: 'me_ended_pin_title', body: 'me_ended_pin_body', device: null };
    case 'account_deleted':
      return { title: 'me_ended_deleted_title', body: 'me_ended_deleted_body', device: null };
    case 'expired':
      return { title: 'me_ended_expired_title', body: 'me_ended_expired_body', device: null };
    default: {
      const label = info.deviceLabel && DEVICES.has(info.deviceLabel) ? info.deviceLabel : 'other';
      return { title: 'me_ended_other_title', body: 'me_ended_other_body', device: `me_device_${label}` };
    }
  }
}
