/**
 * Issue #854 follow-up — finishing a sign-out the server could not confirm.
 *
 * `POST /api/auth/logout` always clears the browser's session cookie: that is
 * its one unconditional job, and a member who pressed «خروج» must not keep a
 * working cookie because the database hiccupped. But once the cookie is gone,
 * nothing in the browser names the session any more — so if ending its
 * `employee_sessions` row failed, a "retry" would find no session and report a
 * success that ended nothing, while a copy of the token kept elsewhere stays
 * valid until it expires.
 *
 * The route therefore answers an unconfirmed sign-out with a **retry ticket**:
 * a short JWT naming exactly the session(s) the signed token named, set as an
 * httpOnly, `SameSite=Strict` cookie scoped to `/api/auth/logout`, so script
 * cannot read it and no other route ever receives it. `POST
 * /api/auth/logout/retry` reads it and tries the revocation again.
 *
 * The ticket can only *end* a session — never resume one — and it is signed
 * with the tenant key under a realm claim `verifySession` refuses
 * (`realm !== "tenant"`), so it cannot pass for a session token. It expires
 * with the session it names: after that the token is dead anyway.
 *
 * Since the third pass a session is one of two things, and the ticket names
 * either: a member's `employee_sessions` row, or — for a support operator
 * signed in as the business — the support grant the session is bound to.
 */
import { SignJWT } from "jose";
import { getRealmSecret, verifyWithRealmSecret } from "./jwt-secret";
import { isUuid } from "./uuid";

export const LOGOUT_RETRY_COOKIE = "pos_logout_retry";
const TICKET_REALM = "tenant.logout_retry";
/** A handful is plenty: one per sign-out this browser could not confirm. */
const MAX_PENDING = 5;

/** One member session a sign-out could not yet confirm ended. */
export interface PendingSessionRevocation {
  kind: "employee_session";
  /** `employee_sessions.id`, from the signed session token. */
  sessionId: string;
  businessId: string;
  /** The member the session belongs to — the revocation is restricted to their own row. */
  employeeId: string;
  /** Epoch seconds after which the session token is dead regardless. */
  expiresAt: number;
}

/**
 * One support session a sign-out could not yet confirm closed: the grant the
 * operator's tenant token is bound to (`imp.grantId`), closed exactly as the
 * support banner's «پایان نشست پشتیبانی» closes it — by that operator, inside
 * that business.
 */
export interface PendingSupportRevocation {
  kind: "support_grant";
  grantId: string;
  businessId: string;
  /** The operator the grant belongs to — the close is restricted to their own grant. */
  adminId: string;
  /** Epoch seconds after which the session token is dead regardless. */
  expiresAt: number;
}

export type PendingRevocation = PendingSessionRevocation | PendingSupportRevocation;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isPending(value: unknown): value is PendingRevocation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!isUuid(v.businessId) || typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) {
    return false;
  }
  if (v.kind === "employee_session") return isUuid(v.sessionId) && isUuid(v.employeeId);
  if (v.kind === "support_grant") return isUuid(v.grantId) && isUuid(v.adminId);
  return false;
}

/** What an entry ends — the key a ticket de-duplicates on. */
export function pendingRevocationKey(entry: PendingRevocation): string {
  return entry.kind === "employee_session"
    ? `employee_session:${entry.sessionId}`
    : `support_grant:${entry.grantId}`;
}

/** Live, de-duplicated, capped — the newest entries win. */
export function normalizePending(entries: readonly PendingRevocation[]): PendingRevocation[] {
  const now = nowSeconds();
  const byKey = new Map<string, PendingRevocation>();
  for (const entry of entries) {
    if (!isPending(entry) || entry.expiresAt <= now) continue;
    const key = pendingRevocationKey(entry);
    // Re-inserted, so a repeated entry counts as the newest.
    byKey.delete(key);
    byKey.set(key, entry);
  }
  return [...byKey.values()].slice(-MAX_PENDING);
}

/** Sign a ticket for `entries`, or null when nothing is left pending. */
export async function signLogoutRetryTicket(
  entries: readonly PendingRevocation[],
): Promise<{ token: string; maxAgeSeconds: number } | null> {
  const pending = normalizePending(entries);
  if (pending.length === 0) return null;
  const expiresAt = Math.max(...pending.map((p) => p.expiresAt));
  const token = await new SignJWT({ realm: TICKET_REALM, pending })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(await getRealmSecret("tenant"));
  return { token, maxAgeSeconds: Math.max(60, expiresAt - nowSeconds()) };
}

/** The sessions a ticket names — empty for a missing, forged, expired or foreign token. */
export async function readLogoutRetryTicket(token: string | null | undefined): Promise<PendingRevocation[]> {
  if (!token) return [];
  try {
    const payload = await verifyWithRealmSecret<{ realm?: unknown; pending?: unknown }>(token, "tenant");
    if (!payload || payload.realm !== TICKET_REALM || !Array.isArray(payload.pending)) return [];
    return normalizePending(payload.pending.filter(isPending));
  } catch {
    return [];
  }
}

/** Cookie attributes for the ticket: unreadable by script, sent to the sign-out routes only. */
export function logoutRetryCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/logout",
    maxAge: maxAgeSeconds,
  };
}
