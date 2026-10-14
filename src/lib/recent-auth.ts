/**
 * Step-up / recent-authentication policy (Issue #809 — Finding 7).
 *
 * Sensitive account-management mutations — adding, replacing or removing a
 * second factor, regenerating recovery codes, changing a verified login phone,
 * changing a password, or revoking all sessions everywhere — must not rely on
 * a long-lived session cookie alone. A walked-up-to terminal or a long-lived
 * browser session must re-prove identity if the most recent authentication on
 * the session is older than `RECENT_AUTH_WINDOW_SECONDS` (15 minutes).
 *
 * Pure policy helpers live here so both tenant and platform routes share one
 * definition and unit tests can exercise every boundary without a database.
 */
import { NextResponse } from "next/server";

/** Default freshness window for sensitive account-security mutations (15 minutes). */
export const RECENT_AUTH_WINDOW_SECONDS = 15 * 60;

export interface SessionWithAuthTimestamp {
  recentAuthAt?: number;
  iat?: number;
}

export function nowEpochSeconds(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000);
}

/**
 * Extracts the epoch-seconds timestamp of the most recent authentication on
 * `session`. Prefers explicit `recentAuthAt` (stamped at login, MFA verify, or
 * step-up re-verification) and falls back to the JWT's `iat` claim.
 */
export function sessionAuthEpoch(
  session: SessionWithAuthTimestamp | null | undefined,
): number | null {
  if (!session) return null;
  if (typeof session.recentAuthAt === "number" && Number.isFinite(session.recentAuthAt)) {
    return session.recentAuthAt;
  }
  if (typeof session.iat === "number" && Number.isFinite(session.iat)) {
    return session.iat;
  }
  return null;
}

/**
 * Whether `session` was authenticated within `maxAgeSeconds` of `now`.
 */
export function isRecentAuth(
  session: SessionWithAuthTimestamp | null | undefined,
  now: Date = new Date(),
  maxAgeSeconds: number = RECENT_AUTH_WINDOW_SECONDS,
): boolean {
  const epoch = sessionAuthEpoch(session);
  if (epoch === null) return false;
  const ageSeconds = nowEpochSeconds(now) - epoch;
  // Allow small clock skew (-60s) and require age <= maxAgeSeconds.
  return ageSeconds >= -60 && ageSeconds <= maxAgeSeconds;
}

/**
 * Enforces recent authentication for a sensitive account action.
 *
 * Returns `null` when allowed (either `inlineVerified` is true because the
 * caller supplied a valid current password / OTP / PIN in the request, or the
 * session's `recentAuthAt` / `iat` is within `maxAgeSeconds`), or a `403`
 * `NextResponse` with `{ error: "recent_auth_required" }` when stale.
 */
export function requireRecentAuth(
  session: SessionWithAuthTimestamp | null | undefined,
  options: {
    now?: Date;
    maxAgeSeconds?: number;
    inlineVerified?: boolean;
  } = {},
): NextResponse | null {
  if (options.inlineVerified === true) return null;
  const maxAgeSeconds = options.maxAgeSeconds ?? RECENT_AUTH_WINDOW_SECONDS;
  if (isRecentAuth(session, options.now, maxAgeSeconds)) {
    return null;
  }
  return NextResponse.json(
    {
      error: "recent_auth_required",
      maxAgeSeconds,
    },
    { status: 403 },
  );
}
