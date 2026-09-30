// A small HTTP toolkit on top of node:http: routing with :params, JSON bodies, errors,
// Server-Sent Events and static files. Enough for this product, nothing more.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { AppError } from './util.ts';

export type Req = {
  method: string;
  path: string;
  url: string; // path + query string, as sent (used for request signatures)
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  rawBody: string;
  body: any;
  raw: IncomingMessage;
  res: ServerResponse;
};

export type Handler = (req: Req) => unknown | Promise<unknown>;

type Route = { method: string; parts: string[]; handler: Handler };

const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 1024 * 1024; // camera pictures from the table host (/v1/host/...)

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  patch(p: string, h: Handler) { return this.on('PATCH', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (r.parts[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

export function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new AppError(413, 'BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Server-Sent Events: the browser's EventSource reconnects by itself, no library needed.
export function openStream(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => clearInterval(ping));
  return send;
}

export const STREAMED = Symbol('streamed'); // handler already wrote the response

export function sendJpeg(res: ServerResponse, data: Buffer) {
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': data.length, 'x-content-type-options': 'nosniff' });
  res.end(data);
  return STREAMED;
}

export async function dispatch(router: Router, raw: IncomingMessage, res: ServerResponse, onError: (e: unknown) => void) {
  const url = new URL(raw.url ?? '/', 'http://local');
  try {
    const found = router.match(raw.method ?? 'GET', url.pathname);
    if (!found) throw new AppError(404, 'NOT_FOUND');
    const rawBody = raw.method === 'GET' || raw.method === 'HEAD' ? '' : await readBody(raw, url.pathname.startsWith('/v1/host/') ? MAX_UPLOAD : MAX_BODY);
    let body: any = {};
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { throw new AppError(400, 'BAD_JSON'); }
    }
    const out = await found.handler({
      method: raw.method ?? 'GET', path: url.pathname, url: url.pathname + url.search, query: url.searchParams,
      params: found.params, headers: raw.headers, rawBody, body, raw, res,
    });
    if (out !== STREAMED) sendJson(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof AppError) return sendJson(res, e.status, { error: e.code, message: e.message });
    onError(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: 'Unexpected error' });
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

export async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(root, decodeURIComponent(rel)));
  if (!file.startsWith(root + sep)) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src *; frame-src *; style-src 'self' 'unsafe-inline'",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
