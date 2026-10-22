import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { AppContext } from './context.js';
import { errorHandler } from './http/errors.js';
import { loadUser } from './modules/auth/session.js';
import { apiRouter } from './modules/index.js';

const JSON_LIMIT = '2mb';

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Stripe webhooks are verified against the raw body (commerce module); json() skips an already-read body.
  app.use('/api/commerce/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: JSON_LIMIT }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', loadUser(ctx), apiRouter(ctx));
  app.use('/api', (_req, res) => { res.status(404).json({ success: false, error: { code: 'not_found', params: {} } }); });
  app.use(errorHandler(ctx.logger));
  return app;
}
