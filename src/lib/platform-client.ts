/**
 * The super-admin console's HTTP client — one place that turns a `/api/platform`
 * call into a typed success/error result the whole console can rely on.
 *
 * Before this, every page reimplemented `fetch` + `res.json()` + ad-hoc error
 * handling; the result was inconsistent handling of 401/403/validation/network
 * failures. This client normalises all of them into a discriminated union so a
 * caller never has to guess whether `data` is a payload or an error, and the
 * accompanying React hooks (`usePlatformQuery`, `usePlatformMutation`) remove
 * the repeated `useState/useEffect/loading/error/reload` boilerplate.
 *
 * Pure transport — no React — so it can be unit-tested and reused server-side.
 */

/** The stable error envelope every `/api/platform` route returns on failure. */
export interface PlatformApiErrorBody {
  error: string;
  /** Optional per-field validation messages, keyed by field name. */
  fields?: Record<string, string>;
  /** Optional free-form detail for logging (never shown raw to operators). */
  detail?: string;
}

export type PlatformResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      /** A stable machine code — feed to `platformErrorText` for operator text. */
      code: string;
      /** Field-level validation errors when the server supplied them. */
      fields?: Record<string, string>;
      /**
       * The parsed error body, when the server sent one. Callers that render
       * richer diagnostics (a media storage step-by-step result, a support
       * `reference`, an actionable `message`) need more than the code; dropping
       * the rest forced them to re-fetch the endpoint with raw `fetch`.
       */
      body?: Record<string, unknown>;
      /** True when the failure was a client-side abort, not a server response. */
      cancelled?: boolean;
    };

export interface PlatformRequestOptions extends Omit<RequestInit, "body"> {
  /** JSON body — serialised automatically; omit for GET. */
  body?: unknown;
  /** Query-string params appended to the URL; nullish values are dropped. */
  params?: Record<string, string | number | boolean | null | undefined>;
  /** An AbortSignal to cancel the request (used for stale-search cancellation). */
  signal?: AbortSignal;
}

/** Build a URL with a query string from a params record, dropping nullish. */
export function withParams(
  url: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

/** Map an HTTP status with no explicit body code to a stable code. */
function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "validation_error";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "server_error" : "bad_request";
  }
}

/**
 * Perform a `/api/platform` request and normalise the outcome. Never throws for
 * an HTTP error or a network failure — the failure lands in the returned union
 * so callers handle it uniformly. Only a caller-driven abort surfaces as
 * `cancelled: true` (still `ok: false`, code `request_cancelled`).
 */
export async function platformFetch<T = unknown>(
  url: string,
  options: PlatformRequestOptions = {},
): Promise<PlatformResult<T>> {
  const { body, params, headers, signal, ...rest } = options;
  const finalUrl = withParams(url, params);
  const method = (rest as { method?: string }).method ?? "GET";

  let res: Response;
  try {
    res = await fetch(finalUrl, {
      ...rest,
      signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 0, code: "request_cancelled", cancelled: true };
    }
    // Section 12 follow-up: a transport failure (offline, DNS, dropped
    // connection) never reached a server to fail meaningfully — worth the
    // same exportable log entry a render error gets. See error-report.ts.
    await recordNotableFailure({ method, url: finalUrl, status: 0, code: "network_error" });
    return { ok: false, status: 0, code: "network_error" };
  }

  // 204 / empty body — success with no data.
  if (res.status === 204) {
    return { ok: true, status: res.status, data: undefined as T };
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (res.ok) {
        return { ok: false, status: res.status, code: "parse_error" };
      }
      // A non-OK non-JSON body (e.g. an HTML error page) — use the status.
      await recordNotableFailure({ method, url: finalUrl, status: res.status });
      return { ok: false, status: res.status, code: codeForStatus(res.status) };
    }
  }

  if (res.ok) {
    return { ok: true, status: res.status, data: (parsed ?? {}) as T };
  }

  const errBody = (parsed ?? {}) as Partial<PlatformApiErrorBody>;
  const code = typeof errBody.error === "string" && errBody.error ? errBody.error : codeForStatus(res.status);
  await recordNotableFailure({ method, url: finalUrl, status: res.status, code });
  const errorBody =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  return {
    ok: false,
    status: res.status,
    code,
    fields: errBody.fields,
    body: errorBody,
  };
}

/**
 * Logs a server-side (5xx) or transport failure into the same exportable
 * client-error ring buffer a render error uses — see error-report.ts's
 * module doc for why only these, not ordinary validation rejections, are
 * worth recording. A dynamic import keeps this module's own dependency
 * surface (and its existing unit tests, which stub `fetch` directly with no
 * DOM/localStorage) unchanged for every caller that never hits this path.
 */
async function recordNotableFailure(context: { method: string; url: string; status: number; code?: string }): Promise<void> {
  if (context.status !== 0 && context.status < 500) return;
  try {
    const { recordApiFailure } = await import("./error-report");
    recordApiFailure(context);
  } catch {
    // Best-effort only — logging a failure must never itself throw.
  }
}
