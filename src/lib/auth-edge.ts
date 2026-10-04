/**
 * Session primitives that are safe to run in the Edge runtime.
 *
 * `src/middleware.ts` runs on Edge, where `node:async_hooks` does not exist —
 * and since Phase 12 `src/lib/auth.ts` pulls in the tenant context (which is
 * built on AsyncLocalStorage) and the database pool. Splitting the pure token
 * handling out keeps the middleware bundle free of both, while `auth.ts`
 * re-exports everything here so the ~93 route handlers that import from
 * `@/lib/auth` are unaffected.
 *
 * Everything in this file depends only on `jose`, which works in both runtimes.
 */
import { SignJWT, jwtVerify } from "jose";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";

export const SESSION_COOKIE = "pos_session";

/**
 * Phase 17 security review — the tenant and platform-admin realms share one
 * JWT_SECRET (platform-auth-edge.ts reads the same env var). That file
 * already stamps a `realm: "platform"` claim and rejects any token missing
 * or mismatching it, so a tenant token was already refused there — but this
 * side never checked the reverse: a platform token verifies fine against
 * `verifySession` today, since nothing here looks at `realm` at all. Stamping
 * and requiring `realm: "tenant"` (below) closes that direction too, the
 * same way, rather than inventing a second convention.
 */
const REALM = "tenant";

/**
 * A membership's role within one business.
 *
 * `accountant` arrived with Phase 12 for the accounting suite in Phase 16: it
 * works the books without touching the till or the floor.
 *
 * `admin` and `viewer` arrived with the authorization refactor. `admin` is the
 * tenant administrator that `manager` had been standing in for — everything
 * short of the owner-only capabilities — so that running the business and
 * administering the tenant stop being the same grant. `viewer` is the
 * read-only auditor. Both are additive: no existing membership holds either,
 * so no tenant's behaviour changes until somebody assigns one.
 */
export type Role = "owner" | "admin" | "manager" | "accountant" | "cashier" | "waiter" | "kitchen";

export interface SessionPayload {
  /** users.id — the *membership* acting, not the person. See migration 0020. */
  sub: string;
  role: Role;
  /** The tenant every query in this request will be scoped to. */
  businessId: string;
  /**
   * The business's stable internal slug. It no longer appears in any URL the
   * app generates — the origin names the business now — but middleware still
   * needs it to translate a bookmarked `/{slug}/dashboard` into the host that
   * serves that business today, which it cannot look up in the Edge runtime.
   * Optional so a token minted before this field existed still verifies; such
   * a session simply sends that one redirect through the Node-runtime resolver
   * instead.
   */
  businessSlug?: string;
  /**
   * Phase 23 — the business's public DNS label, and the origin this session is
   * valid on. Carried on the token for the same reason `businessSlug` is:
   * middleware runs on Edge and cannot query Postgres, so comparing the host's
   * label against this claim is the only tenant check available there — and it
   * is the isolation boundary, so it fails closed.
   *
   * Optional so a token minted before this claim existed still verifies. When
   * subdomain routing is on, a session without it is treated as not valid on
   * any business origin and sent back to log in, which re-mints one; when it
   * is off, nothing reads this field.
   */
  businessSubdomain?: string;
  /** This membership's default/home branch; null = roaming (owner or unassigned manager). */
  locationId: string | null;
  /**
   * Phase 14 — the branch currently "in view" for scoped screens, chosen via
   * `/api/auth/switch-location`. Undefined on tokens issued before Phase 14
   * (and briefly after login, before a switch): `resolveActiveLocation`
   * (src/lib/setup-state.ts) treats that the same as an inaccessible branch
   * and falls back to the member's default accessible one, so an old token
   * degrades gracefully rather than needing everyone to re-log-in.
   */
  activeLocationId?: string | null;
  fullName: string;
  /**
   * platform_users.id — the person behind the membership, present only for
   * password logins. PIN-only staff have no global identity. Carried so
   * "switch business" can find this person's other memberships without a
   * second authentication.
   */
  platformUserId?: string | null;
  /** Phase 24 Wave 5 — used for password login revocation (checked against platform_users.token_version) */
  tokenVersion?: number;
  /**
   * Phase 15 — set only when this tenant session was minted by the super-admin
   * console entering the business (impersonation). It names the grant, the
   * platform admin behind it, and the blast radius. Its presence is what the
   * middleware and guards key on to (a) block every mutating request when the
   * mode is `read_only`, and (b) tag the acting session as an operator, not the
   * owner whose seat it borrows. A normal tenant login never carries it.
   */
  imp?: {
    /** impersonation_grants.id — re-checked live on the server, never trusted alone. */
    grantId: string;
    /** platform_admins.id — the operator accountable for anything done here. */
    adminId: string;
    mode: "read_only" | "controlled" | "full" | "emergency";
    /** Server-derived technical writes; never populated from a browser request. */
    allowedCapabilities?: string[];
  };
  /**
   * Phase 20 Wave 2 — employee_sessions.id, set only when this token was
   * minted by pin-login. The JWT stays the bearer credential in the cookie
   * (this is *not* a session lookup key); the row it names is what makes the
   * session individually revocable and listable, re-checked live on the
   * server by checkEmployeeSession in auth.ts the same way impersonation
   * grants are — never trusted alone, same as `imp.grantId` above. Absent on
   * password-role logins (owner/manager/accountant never go through
   * pin-login) and on any token minted before this field existed.
   */
  employeeSessionId?: string | null;
  /** True when this session completed MFA verification at login. */
  mfaVerified?: boolean;
  /** Epoch seconds of the most recent primary/MFA/step-up authentication. */
  recentAuthAt?: number;
  /** Registered JWT issued-at claim (epoch seconds). */
  iat?: number;
}




export function sessionHours(): number {
  const h = Number(process.env.SESSION_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const secret = await getRealmSecret("tenant");
  return new SignJWT({ ...payload, realm: REALM })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${sessionHours()}h`)
    .sign(secret);
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const payload = await verifyWithRealmSecret<{ realm?: string }>(token, "tenant");
    if (!payload || payload.realm !== REALM) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * There is deliberately no `domain` attribute here, and that omission is
 * load-bearing — do not "fix" it.
 *
 * Without one the cookie is host-scoped: the browser sends it only back to the
 * exact host that set it, so a session minted on `acme.pos.eshobe.com` is
 * never sent to `beta.pos.eshobe.com`. That is the entire point of Phase 23's
 * move to per-business origins. Setting `domain=.pos.eshobe.com` would make
 * one cookie valid across every tenant subdomain and silently undo the whole
 * wave, while everything would appear to keep working.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionHours() * 60 * 60,
  };
}
