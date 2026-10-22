import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Google Identity Services, loaded on demand only when Google sign-in is configured. */
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

export interface GoogleConfig { enabled: boolean; clientId: string | null }

export type GoogleSignInResult =
  | { token: string; user: import('../../state/session').User; needsRegistration?: undefined }
  | { needsRegistration: true; registrationToken: string; email: string; suggestedUsername: string; emailTaken: boolean };

interface GisApi {
  accounts: {
    id: {
      initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup' }): void;
      renderButton(el: HTMLElement, opts: Record<string, string | number>): void;
    };
  };
}

declare global {
  interface Window { google?: GisApi }
}

export const useGoogleConfig = () => useQuery({
  queryKey: ['google-config'],
  queryFn: () => api.get<GoogleConfig>('/auth/google/config'),
  staleTime: 5 * 60_000,
});

const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Viber|Line\/|MicroMessenger|Snapchat|TikTok/i;

/** Google blocks sign-in inside social apps' built-in browsers. */
export function isInAppBrowser(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return IN_APP.test(ua);
}

let loading: Promise<GisApi> | null = null;

export function loadGis(): Promise<GisApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  loading ??= new Promise<GisApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.google ? resolve(window.google) : reject(new Error('gis_missing')));
    script.onerror = () => { loading = null; reject(new Error('gis_load_failed')); };
    document.head.appendChild(script);
  });
  return loading;
}
