/**
 * Issue #948 P0/P1-5 — "is the cloud host answering *right now*?", asked
 * directly instead of inferred from the last sync error.
 *
 * `/api/connection/status` used to map any persisted push/pull/IAM error to
 * `cloud: unreachable`, which is a claim about *transport* made from a stale
 * write failure. This module is the missing fresh fact: a bounded, rate-limited
 * probe of the cloud's own session-less `/api/health` (the same liveness
 * endpoint this install exposes). Results are cached per remote URL so one
 * status poll per 60 seconds is the most that ever leaves the site — the POS
 * keeps running on local PostgreSQL regardless of what this answers.
 */

export type CloudReachability =
  | "reachable"
  | "unreachable"
  | "server_error"
  | "http_error"
  | "unknown";

export interface CloudReachabilityResult {
  state: CloudReachability;
  checkedAt: string | null;
  /** True when this answer came from the cache, not a fresh probe. */
  cached: boolean;
  /** HTTP status when the host answered with one. Never a body or a token. */
  httpStatus: number | null;
}

const TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

interface CacheEntry {
  result: Omit<CloudReachabilityResult, "cached">;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function baseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Probe the cloud host. Never throws; `remoteUrl` empty/unusable is
 * `unknown` without any network traffic. Cached per remote URL for
 * `TTL_MS`; on cache expiry exactly one caller probes while concurrent
 * callers keep serving the stale answer rather than stampeding.
 */
export async function probeCloudReachability(
  remoteUrl: string | null | undefined,
  options: { force?: boolean } = {},
): Promise<CloudReachabilityResult> {
  const url = baseUrl(remoteUrl ?? "");
  if (!url) return { state: "unknown", checkedAt: null, cached: true, httpStatus: null };
  const entry = cache.get(url);
  const now = Date.now();
  if (entry && !options.force && entry.expiresAt > now) {
    return { ...entry.result, cached: true };
  }
  // Mark in-flight so a second status poll within the probe window does not
  // fire its own request.
  const stale = entry?.result ?? { state: "unknown" as CloudReachability, checkedAt: null, httpStatus: null };
  cache.set(url, { result: stale, expiresAt: now + TTL_MS });
  try {
    const response = await fetch(`${url}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const result = {
      state: response.ok
        ? ("reachable" as const)
        : response.status >= 500
          ? ("server_error" as const)
          : ("http_error" as const),
      checkedAt: new Date().toISOString(),
      httpStatus: response.status,
    };
    cache.set(url, { result, expiresAt: Date.now() + TTL_MS });
    return { ...result, cached: false };
  } catch {
    const result = {
      state: "unreachable" as const,
      checkedAt: new Date().toISOString(),
      httpStatus: null,
    };
    cache.set(url, { result, expiresAt: Date.now() + TTL_MS });
    return { ...result, cached: false };
  }
}

/** Test seam: forget every cached probe. */
export function resetCloudReachabilityCache(): void {
  cache.clear();
}
