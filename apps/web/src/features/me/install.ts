import { useSyncExternalStore } from 'react';

/** Chromium's install event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

/** Keeps Chromium's install prompt so we can show our own "Install" button. Safe to call more than once. */
let captured = false;
export function captureInstallPrompt(target: Window = window): void {
  if (captured) return;
  captured = true;
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  target.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

/** Running as an installed app (home-screen / standalone display). */
export function isStandalone(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
  } catch {
    return false;
  }
}

/** iPhone / iPad Safari, where installing is a manual "Add to Home Screen". */
export function isIos(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

export interface InstallState {
  readonly canPrompt: boolean;
  readonly ios: boolean;
  readonly installed: boolean;
}

export function useInstall(): InstallState & { prompt(): Promise<boolean> } {
  const canPrompt = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => deferred !== null,
  );
  return {
    canPrompt,
    ios: isIos(),
    installed: isStandalone(),
    async prompt() {
      const event = deferred;
      if (!event) return false;
      deferred = null;
      notify();
      await event.prompt();
      return (await event.userChoice).outcome === 'accepted';
    },
  };
}
