/**
 * Minimal HTTP abstraction shared by the connector API client and the Discord
 * client. Production uses the runtime's global `fetch`; tests inject a mock.
 * Pure Node: no Electron import.
 */

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Serialized as JSON when present. */
  body?: unknown;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  data: unknown;
}

/** A transport-level failure: no HTTP status was received. */
export class NetworkError extends Error {
  /** A short machine code such as ECONNREFUSED, ENOTFOUND, or TIMEOUT. */
  readonly code: string;
  readonly timedOut: boolean;
  constructor(code: string, timedOut: boolean) {
    super(timedOut ? 'request timed out' : `network error: ${code}`);
    this.name = 'NetworkError';
    this.code = code;
    this.timedOut = timedOut;
  }
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

function errorCodeOf(err: unknown): string {
  // undici wraps the socket error in `cause`.
  const candidates = [err, (err as { cause?: unknown } | null)?.cause];
  for (const c of candidates) {
    const code = (c as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  }
  return 'CONNECTION_ERROR';
}

/** The production transport: global fetch with a hard timeout. */
export const fetchHttpClient: HttpClient = async (req) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: outHeaders, data };
  } catch (err) {
    if (timedOut) throw new NetworkError('TIMEOUT', true);
    throw new NetworkError(errorCodeOf(err), false);
  } finally {
    clearTimeout(timer);
  }
};
