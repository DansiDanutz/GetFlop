import { useSyncExternalStore } from 'react';

export type Lang = 'en' | 'el';
type Dict = Record<string, string>;

// Every feature keeps its own dictionary file: locales/<lang>/<feature>.ts (default export).
const modules = import.meta.glob<{ default: Dict }>('./locales/*/*.ts', { eager: true });
const dictionaries: Record<Lang, Dict> = { en: {}, el: {} };
for (const [path, mod] of Object.entries(modules)) {
  const lang = path.split('/')[2] as Lang;
  if (dictionaries[lang]) Object.assign(dictionaries[lang], mod.default);
}

const STORAGE_KEY = 'getflop_lang';
let current: Lang = readStoredLang();
const listeners = new Set<() => void>();

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'el' ? 'el' : 'en';
  } catch {
    return 'en';
  }
}

export function getLanguage(): Lang {
  return current;
}

export function setLanguage(lang: Lang): void {
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* storage unavailable */ }
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

export type Params = Record<string, string | number | null | undefined>;

/** Translates a key, falling back to English, then to the key itself. {name} placeholders are filled from params. */
export function t(key: string, params: Params = {}): string {
  const template = dictionaries[current][key] ?? dictionaries.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export function hasKey(key: string): boolean {
  return key in dictionaries.en;
}

/** Message for an API error code ("coupon.min_stake" → err_coupon_min_stake). */
export function errorMessage(code: string, params: Params = {}): string {
  const key = `err_${code.replace(/\./g, '_')}`;
  return hasKey(key) ? t(key, params) : t('err_generic');
}

/** Re-renders the component when the language changes; returns t. */
export function useT(): typeof t {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
  return t;
}
