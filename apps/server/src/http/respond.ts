import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps an async handler: its return value is sent as { success: true, data }. */
export function handle<T>(fn: (req: Request, res: Response) => Promise<T> | T): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) res.json({ success: true, data: data ?? null });
    } catch (err) {
      next(err);
    }
  };
}
