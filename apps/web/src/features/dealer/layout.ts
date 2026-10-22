import { useCallback, useEffect, useState } from 'react';

/** Card entry layout, stored per device. `auto` resolves from the screen. */
export type LayoutMode = 'auto' | 'compact' | 'full';
export type Layout = 'compact' | 'full';

export interface ScreenInfo {
  readonly width: number;
  readonly height: number;
  /** Touch screen (pointer: coarse). */
  readonly coarse: boolean;
}

const STORAGE_KEY = 'getflop_dealer_layout';
const COMPACT_MAX_WIDTH = 640;
const COMPACT_MAX_HEIGHT_TOUCH = 500;
const MODES: readonly LayoutMode[] = ['auto', 'compact', 'full'];

export function autoLayout(screen: ScreenInfo): Layout {
  if (screen.width <= COMPACT_MAX_WIDTH) return 'compact';
  return screen.height <= COMPACT_MAX_HEIGHT_TOUCH && screen.coarse ? 'compact' : 'full';
}

export function resolveLayout(mode: LayoutMode, screen: ScreenInfo): Layout {
  return mode === 'auto' ? autoLayout(screen) : mode;
}

/** The header toggle: auto → the opposite of what auto picks → back to auto. */
export function nextMode(mode: LayoutMode, screen: ScreenInfo): LayoutMode {
  if (mode !== 'auto') return 'auto';
  return autoLayout(screen) === 'compact' ? 'full' : 'compact';
}

export function layoutLabelKey(mode: LayoutMode, screen: ScreenInfo): string {
  return mode === 'auto' ? `dealer_layout_auto_${autoLayout(screen)}` : `dealer_layout_${mode}`;
}

/** The subset of Web Storage used here (injectable for tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function deviceStore(): KeyValueStore | null {
  try {
    const store = window.localStorage;
    return store && typeof store.getItem === 'function' ? store : null;
  } catch {
    return null;
  }
}

export function readMode(store: KeyValueStore | null = deviceStore()): LayoutMode {
  try {
    const v = store?.getItem(STORAGE_KEY) ?? null;
    return MODES.includes(v as LayoutMode) ? (v as LayoutMode) : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeMode(mode: LayoutMode, store: KeyValueStore | null = deviceStore()): void {
  try { store?.setItem(STORAGE_KEY, mode); } catch { /* storage unavailable: the choice lasts this visit */ }
}

function currentScreen(): ScreenInfo {
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return { width: window.innerWidth, height: window.innerHeight, coarse };
}

/** Mode + the resolved layout, following screen resizes. Changing the mode persists it. */
export function useLayoutMode(): { mode: LayoutMode; layout: Layout; screen: ScreenInfo; setMode: (m: LayoutMode) => void } {
  const [mode, setModeState] = useState<LayoutMode>(() => readMode());
  const [screen, setScreen] = useState<ScreenInfo>(currentScreen);
  useEffect(() => {
    const onResize = () => setScreen(currentScreen());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const setMode = useCallback((m: LayoutMode) => { writeMode(m); setModeState(m); }, []);
  return { mode, layout: resolveLayout(mode, screen), screen, setMode };
}
