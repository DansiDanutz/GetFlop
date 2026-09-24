/** A failed API call. `code` maps to the translation key err_<code with dots → underscores>. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

let clubIdHeader: string | null = null;
let onUnauthorized: ((code: string) => void) | null = null;

/** The club every request acts on (X-Club-Id). Set by the session provider. */
export function setApiClub(clubId: string | null): void {
  clubIdHeader = clubId;
}

export function setUnauthorizedHandler(fn: (code: string) => void): void {
  onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (clubIdHeader) headers['X-Club-Id'] = clubIdHeader;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network.offline', 0);
  }
  const json = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; error: { code: string; params?: Record<string, string | number> } }
    | null;
  if (!json) throw new ApiError('server.error', res.status);
  if (!json.success) {
    const err = new ApiError(json.error.code, res.status, json.error.params ?? {});
    if (res.status === 401) onUnauthorized?.(err.code);
    throw err;
  }
  return json.data;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}`;
}
