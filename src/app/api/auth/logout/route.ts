import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionHours, verifySession } from "@/lib/auth";
import type { LogoutOutcome } from "@/lib/logout-contract";
import { LOGOUT_RETRY_COOKIE, readLogoutRetryTicket, type PendingRevocation } from "@/lib/logout-retry";
import { endSignedOutSession, logoutResponse } from "@/lib/logout-service";

/**
 * Sign this browser out (Phase 20 Wave 2; #854 follow-up).
 *
 * Clearing the session cookie stays this route's one unconditional job — every
 * answer clears it, whatever happened server-side. What changed is that the
 * answer now says what happened (`@/lib/logout-contract`):
 *
 *  - the session's `employee_sessions` row is ended together with its audit row
 *    (`revoked`), or was already gone (`already_ended`); either way a copy of the
 *    token kept anywhere else is refused from now on;
 *  - a session minted without a server-side record (`not_tracked`) has nothing
 *    left to end once its cookie is gone;
 *  - if ending the row failed (`unconfirmed`, HTTP 503), the route used to
 *    swallow the error and answer `{ ok: true }` while the session stayed valid
 *    on the server. Now the member is told, and an httpOnly retry ticket lets
 *    `POST /api/auth/logout/retry` finish the job without the cookie.
 *
 * The session is identified only by this request's own signed cookie
 * (`verifySession`: signature and expiry, deliberately not the live checks — a
 * sign-out must still work for a session the server already considers stale),
 * never by anything in the body. Earlier sign-outs this browser could not
 * confirm ride along in the retry ticket and are retried here too.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  const ticketCookie = request.cookies.get(LOGOUT_RETRY_COOKIE)?.value;
  const pending = await readLogoutRetryTicket(ticketCookie);

  const stillPending: PendingRevocation[] = [];
  let outcome: LogoutOutcome;

  if (!session) {
    outcome = "no_session";
  } else if (!session.employeeSessionId) {
    outcome = "not_tracked";
  } else {
    const entry: PendingRevocation = {
      sessionId: session.employeeSessionId,
      businessId: session.businessId,
      employeeId: session.sub,
      expiresAt:
        typeof session.exp === "number"
          ? session.exp
          : Math.floor(Date.now() / 1000) + sessionHours() * 60 * 60,
    };
    const result = await endSignedOutSession(entry, "sign_out");
    if (result === "failed") {
      outcome = "unconfirmed";
      stillPending.push(entry);
    } else {
      outcome = result;
    }
  }

  for (const entry of pending) {
    if (entry.sessionId === session?.employeeSessionId) continue;
    if ((await endSignedOutSession(entry, "sign_out_retry")) === "failed") stillPending.push(entry);
  }

  return logoutResponse({
    outcome,
    stillPending,
    clearSessionCookie: true,
    hadTicket: Boolean(ticketCookie),
  });
}
