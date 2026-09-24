import type { Db } from './db/client.js';
import type { Logger } from './http/errors.js';
import type { Mailer } from './mailer.js';
import type { Events } from './realtime/events.js';

export interface AppConfig {
  readonly bettingTimerSeconds: number;
  readonly webOrigin: string;
  readonly secureCookies: boolean;
  /** Public base URL of the web app, for invite links and QR codes. */
  readonly publicAppUrl: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  bettingTimerSeconds: 30,
  webOrigin: 'http://localhost:5173',
  secureCookies: false,
  publicAppUrl: 'http://localhost:5173',
};

/** Everything a module needs; built once in main.ts and in tests. */
export interface AppContext {
  readonly db: Db;
  readonly events: Events;
  readonly logger: Logger;
  readonly mailer: Mailer;
  readonly config: AppConfig;
  /** Injectable clock so tests can control time. */
  readonly now: () => Date;
}
