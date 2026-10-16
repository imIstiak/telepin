import { env } from "../../config/env";
import { logger } from "../../config/logger";

export class PinterestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
  get isAuth() {
    return this.status === 401;
  }
  get isPermission() {
    return this.status === 403;
  }
  get isRateLimit() {
    return this.status === 429;
  }
  /** We know for sure the request did not create anything and it is safe to retry. */
  get isRetryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/** The request was sent but no response arrived: the outcome on Pinterest's side is unknown. */
export class PinterestUnknownOutcomeError extends Error {}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  accessToken: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** For GETs we transparently retry transient failures. */
  retries?: number;
}

export async function pinterestRequest<T>(pathname: string, o: RequestOptions): Promise<T> {
  const url = new URL(env.PINTEREST_API_BASE.replace(/\/$/, "") + pathname);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const method = o.method ?? "GET";
  const retries = o.retries ?? (method === "GET" ? 2 : 0);

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${o.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (method === "GET" && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      // For writes we cannot know whether Pinterest processed it.
      if (method !== "GET") throw new PinterestUnknownOutcomeError(`No response from Pinterest (${(e as Error).name}): ${(e as Error).message}`);
      throw new PinterestApiError(`Network error calling Pinterest: ${(e as Error).message}`, 0);
    }
    clearTimeout(timer);

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      try {
        return (await res.json()) as T;
      } catch {
        if (method !== "GET") throw new PinterestUnknownOutcomeError("Pinterest returned an unreadable success response");
        throw new PinterestApiError("Invalid JSON from Pinterest", res.status);
      }
    }

    let payload: { code?: number; message?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      /* ignore */
    }
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    const err = new PinterestApiError(payload.message ?? `Pinterest API error ${res.status}`, res.status, payload.code, retryAfter);
    // A 5xx on a write may still have been processed; treat as unknown to be safe.
    if (method !== "GET" && res.status >= 500 && res.status !== 503) {
      throw new PinterestUnknownOutcomeError(`Pinterest returned ${res.status} for a write: ${err.message}`);
    }
    if (err.isRetryable && method === "GET" && attempt < retries) {
      const wait = (retryAfter ?? 2 ** attempt) * 1000;
      logger.warn({ status: res.status, path: pathname, wait }, "Pinterest transient error, retrying");
      await sleep(Math.min(wait, 30_000));
      continue;
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pinUrl(pinId: string) {
  return `https://www.pinterest.com/pin/${pinId}/`;
}
