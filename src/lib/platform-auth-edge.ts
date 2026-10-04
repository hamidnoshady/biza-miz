/**
 * Phase 15 — platform-admin session primitives, safe for the Edge runtime.
 *
 * The super-admin console is a *separate auth realm*: its own cookie, its own
 * signed token, and no path from a tenant session into it or back. This file
 * mirrors `auth-edge.ts` (the tenant equivalent) and, for the same reason,
 * depends only on `jose` so `src/middleware.ts` can verify a platform session
 * on Edge without dragging in the pg pool or the tenant context.
 *
 * The token is deliberately a *different cookie* under a *different name* and
 * carries a *different claim shape* (`padmin` instead of `sub`), so a platform
 * token presented to a tenant route fails `verifySession` (wrong shape) and a
 * tenant token presented to a platform route fails `verifyPlatformSession`.
 * That mutual unusability is one of the phase's exit criteria.
 */
import { SignJWT, jwtVerify } from "jose";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";

/** Distinct from the tenant `pos_session` cookie — the realms never share one. */
export const PLATFORM_SESSION_COOKIE = "pos_platform_session";

/**
 * A platform admin's own role. Unlike a tenant `Role`, this governs what the
 * operator may do to the *platform*, not to any one business. Presets live in
 * `src/lib/platform-admin.ts`.
 */
export type PlatformAdminRole = "support" | "engineer" | "owner";

export interface PlatformSessionPayload {
  /** platform_admins.id — the operator behind this session. */
  padmin: string;
  role: PlatformAdminRole;
  fullName: string;
  email: string;
  tokenVersion?: number;
  /** True only when this session was minted after a successful MFA challenge. */
  mfaVerified?: boolean;
  /** auth_admin_sessions.id — server-side session record for individual revocation. */
  sessionId?: string | null;
  /** Epoch seconds of the most recent primary/MFA/step-up authentication. */
  recentAuthAt?: number;
  /** jose supplies this registered claim when verifying a signed session. */
  iat?: number;
}

/**
 * Platform sessions are short by default (2h): an operator console is used in
 * bursts, and a forgotten session is a bigger liability here than on the floor.
 * Overridable with PLATFORM_SESSION_HOURS.
 */
export function platformSessionHours(): number {
  const h = Number(process.env.PLATFORM_SESSION_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 2;
}

export async function signPlatformSession(payload: PlatformSessionPayload): Promise<string> {
  const secret = await getRealmSecret("platform");
  return new SignJWT({ ...payload, realm: "platform" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${platformSessionHours()}h`)
    .sign(secret);
}

export async function verifyPlatformSession(
  token: string,
): Promise<PlatformSessionPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{ realm?: string; padmin?: string }>(token, "platform");
    if (!payload || payload.realm !== "platform") return null;
    if (typeof payload.padmin !== "string") return null;
    return payload as unknown as PlatformSessionPayload;
  } catch {
    return null;
  }
}

export function platformSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    // Deliberately "/", not "/platform": per RFC 6265 cookie-path matching, a
    // cookie scoped to "/platform" is a directory-prefix match only — it is
    // NEVER sent for a request under "/api/platform/*", since "/api" and
    // "/platform" don't share a path prefix. That silently broke every
    // console API call (login would "succeed" and then every subsequent
    // request would 401, since requirePlatformAdmin never saw the cookie at
    // all). Isolation from the tenant realm was never actually resting on the
    // cookie path anyway — it's the distinct cookie NAME and the `realm`
    // claim check in verifyPlatformSession that keep the two apart, and
    // neither of those is weakened by widening this.
    path: "/",
    // No `domain`, for the same load-bearing reason as sessionCookieOptions()
    // in auth-edge.ts: host-scoped means this cookie lives on `admin.` alone
    // and is never sent to a tenant's subdomain. Adding a domain attribute
    // would put the super-admin's credential in every tenant's cookie jar.
    maxAge: platformSessionHours() * 60 * 60,
  };
}
