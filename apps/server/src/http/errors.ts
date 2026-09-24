import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export type ErrorParams = Readonly<Record<string, string | number>>;

/**
 * A failure the client can show. `code` is a stable dotted key ("coupon.min_stake")
 * the web app maps to a translated message (err_coupon_min_stake).
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly params: ErrorParams = {},
  ) {
    super(code);
  }
}

export const notFound = (code: string): AppError => new AppError(code, 404);
export const forbidden = (code = 'auth.forbidden'): AppError => new AppError(code, 403);
export const conflict = (code: string, params?: ErrorParams): AppError => new AppError(code, 409, params);

export interface Logger {
  error(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
}

export const consoleLogger: Logger = {
  // eslint-disable-next-line no-console
  error: (message, meta) => console.error(message, meta ?? ''),
  // eslint-disable-next-line no-console
  info: (message, meta) => console.info(message, meta ?? ''),
};

/** Envelope: { success: false, error: { code, params, message } }. Never leaks internals. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ success: false, error: { code: err.code, params: err.params } });
      return;
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      res.status(400).json({
        success: false,
        error: { code: 'validation.invalid', params: { field: issue?.path.join('.') ?? '', message: issue?.message ?? '' } },
      });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ success: false, error: { code: 'validation.bad_json', params: {} } });
      return;
    }
    logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
    res.status(500).json({ success: false, error: { code: 'server.error', params: {} } });
  };
}
