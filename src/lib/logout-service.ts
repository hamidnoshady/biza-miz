/**
 * Issue #854 follow-up — the server half of the sign-out contract
 * (`@/lib/logout-contract`), shared by `POST /api/auth/logout` and
 * `POST /api/auth/logout/retry`.
 */
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "./auth-edge";
import { withTenant } from "./db";
import { EmployeeError, revokeSession } from "./employee-service";
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

export type EndSessionResult = "revoked" | "already_ended" | "failed";

/**
 * End one session a sign-out names, reporting what actually happened.
 *
 * `revokeSession` commits the revocation and its audit row together, so
 * `revoked` means both are durable; a row that was already revoked or is gone
 * is `already_ended`; anything else (the database, the audit write) is
 * `failed` — logged by its message only, never the token or a row.
 */
export async function endSignedOutSession(
  entry: PendingRevocation,
  via: "sign_out" | "sign_out_retry",
): Promise<EndSessionResult> {
  try {
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
