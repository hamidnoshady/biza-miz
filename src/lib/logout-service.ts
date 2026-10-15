/**
 * Issue #854 follow-up — the server half of the sign-out contract
 * (`@/lib/logout-contract`), shared by `POST /api/auth/logout`,
 * `POST /api/auth/logout/retry` and the business switch (which ends the
 * session it moves away from).
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, sessionHours, type SessionPayload } from "./auth-edge";
import { withTenant } from "./db";
import { EmployeeError, revokeSession, type SessionEndVia } from "./employee-service";
import {
  LOGOUT_MESSAGES,
  LOGOUT_UNCONFIRMED_ERROR,
  type LogoutOutcome,
  type LogoutResponseBody,
} from "./logout-contract";
import {
  LOGOUT_RETRY_COOKIE,
  logoutRetryCookieOptions,
  signLogoutRetryTicket,
  type PendingRevocation,
} from "./logout-retry";
import { closeSupportSession } from "./platform-service";
import { supportCloseMeta } from "./support-session";

export type EndSessionResult = "revoked" | "already_ended" | "failed";

/**
 * What a signed tenant session is bound to on the server — the one thing a
 * sign-out has to end — or null when it is bound to nothing.
 *
 *  - a support session (`imp`) is bound to its grant;
 *  - every other session to its `employee_sessions` row;
 *  - a token with neither was minted before every door opened a row, and
 *    `checkEmployeeSession` already refuses it on every request: there is
 *    nothing left to end.
 *
 * The ids come only from the signed token, never from a request body.
 */
export function pendingRevocationFor(session: SessionPayload): PendingRevocation | null {
  const expiresAt =
    typeof session.exp === "number"
      ? session.exp
      : Math.floor(Date.now() / 1000) + sessionHours() * 60 * 60;
  if (session.imp) {
    return {
      kind: "support_grant",
      grantId: session.imp.grantId,
      businessId: session.businessId,
      adminId: session.imp.adminId,
      expiresAt,
    };
  }
  if (session.employeeSessionId) {
    return {
      kind: "employee_session",
      sessionId: session.employeeSessionId,
      businessId: session.businessId,
      employeeId: session.sub,
      expiresAt,
    };
  }
  return null;
}

/**
 * End one session a sign-out names, reporting what actually happened.
 *
 * A member session goes through `revokeSession`, which commits the revocation
 * and its audit row together, so `revoked` means both are durable; a row that
 * was already revoked or is gone is `already_ended`.
 *
 * A support session goes through `closeSupportSession` — the same service,
 * closer and audit trail as the support banner's «پایان نشست پشتیبانی»
 * (`DELETE /api/support-access`), recorded with a sign-out channel — so there
 * is still one owner of ending a grant. A grant that was already over
 * (ended, revoked, expired) is `already_ended`.
 *
 * Anything else (the database, the audit write) is `failed` — logged by its
 * message only, never the token or a row.
 */
export async function endPendingRevocation(
  entry: PendingRevocation,
  via: SessionEndVia,
  headers: Headers,
): Promise<EndSessionResult> {
  try {
    if (entry.kind === "support_grant") {
      const { status } = await closeSupportSession(
        entry.grantId,
        { type: "operator", adminId: entry.adminId, businessId: entry.businessId },
        supportCloseMeta(headers, via === "sign_out_retry" ? "tenant_sign_out_retry" : "tenant_sign_out"),
      );
      return status === "ended" ? "revoked" : "already_ended";
    }
    await withTenant(entry.businessId, () =>
      revokeSession(entry.sessionId, entry.businessId, entry.employeeId, {
        ownedBy: entry.employeeId,
        via,
      }),
    );
    return "revoked";
  } catch (err) {
    if (err instanceof EmployeeError && err.status === 404) return "already_ended";
    console.error(
      "sign-out could not end the session:",
      err instanceof Error ? err.message : "unknown error",
    );
    return "failed";
  }
}

/**
 * The one response shape both routes answer with: 200 when nothing is left
 * unconfirmed, 503 (with the Persian explanation) when something is. The
 * session cookie is cleared when asked (the sign-out route, always); the retry
 * ticket is re-issued for whatever is still pending and deleted otherwise.
 */
export async function logoutResponse(input: {
  outcome: LogoutOutcome;
  stillPending: readonly PendingRevocation[];
  clearSessionCookie: boolean;
  hadTicket: boolean;
  /** Where the browser goes next, when that is not the sign-in page (a support session: the console). */
  redirectTo?: string;
}): Promise<NextResponse> {
  const ticket = await signLogoutRetryTicket(input.stillPending).catch((err) => {
    // Without a signing key there is no ticket to give; the answer still says
    // the sign-out is unconfirmed, which is the truth.
    console.error(
      "sign-out retry ticket could not be issued:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  });
  const pendingRevocations = ticket ? input.stillPending.length : 0;
  const ok = input.outcome !== "unconfirmed" && input.stillPending.length === 0;
  const body: LogoutResponseBody = {
    ok,
    // An earlier sign-out still pending makes this answer unconfirmed too: the
    // member asked for those sessions to end and they have not.
    outcome: ok ? input.outcome : "unconfirmed",
    sessionCookieCleared: input.clearSessionCookie,
    pendingRevocations: ok ? 0 : Math.max(pendingRevocations, 1),
    ...(input.redirectTo ? { redirectTo: input.redirectTo } : {}),
    ...(ok ? {} : { error: LOGOUT_UNCONFIRMED_ERROR, message: LOGOUT_MESSAGES.unconfirmed }),
  };
  const res = NextResponse.json(body, { status: ok ? 200 : 503 });
  res.headers.set("Cache-Control", "no-store");
  if (input.clearSessionCookie) {
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  }
  if (ticket) {
    res.cookies.set(LOGOUT_RETRY_COOKIE, ticket.token, logoutRetryCookieOptions(ticket.maxAgeSeconds));
  } else if (input.hadTicket) {
    res.cookies.set(LOGOUT_RETRY_COOKIE, "", logoutRetryCookieOptions(0));
  }
  return res;
}
