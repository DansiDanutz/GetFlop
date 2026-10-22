/**
 * Support contacts. Set VITE_SUPPORT_TELEGRAM (handle without @) and VITE_SUPPORT_EMAIL at build time;
 * the defaults are placeholders until the operator provides real contacts.
 */
const env = import.meta.env as Record<string, string | undefined>;

const telegramHandle = env.VITE_SUPPORT_TELEGRAM?.trim() || 'getflop_support';
const email = env.VITE_SUPPORT_EMAIL?.trim() || 'support@getflop.app';

export const SUPPORT = {
  telegramHandle: `@${telegramHandle}`,
  telegramUrl: `https://t.me/${encodeURIComponent(telegramHandle)}`,
  email,
  emailUrl: `mailto:${email}`,
} as const;
