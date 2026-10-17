import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import type { LogoutOutcome } from "@/lib/logout-contract";
import {
  LOGOUT_RETRY_COOKIE,
  pendingRevocationKey,
  readLogoutRetryTicket,
  type PendingRevocation,
} from "@/lib/logout-retry";
import { endPendingRevocation, logoutResponse, pendingRevocationFor } from "@/lib/logout-service";
import { clearNativeDeviceAuthStateOnSignOut } from "@/lib/native-device-service";
import { supportSessionReturnPath } from "@/lib/support-session";

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
 *  - a support operator's session is bound to its grant, not a row: the grant is
 *    closed through the same service and audit trail as the support banner's
 *    exit (`revoked`, or `already_ended` when it was already over), and the
 *    answer carries `redirectTo` — back to the console, not the staff sign-in;
 *  - a token bound to neither predates the third pass and is already refused on
 *    every request (`checkEmployeeSession`), so there is nothing left to end
 *    (`already_ended`). No session reaches this route untracked any more;
 *  - if ending the session failed (`unconfirmed`, HTTP 503), the route used to
 *    swallow the error and answer `{ ok: true }` while the session stayed valid
 *    on the server. Now the member is told, and an httpOnly retry ticket lets
 *    `POST /api/auth/logout/retry` finish the job without the cookie.
 *
 * The session is identified only by this request's own signed cookie
 * (`verifySession`: signature and expiry, deliberately not the live checks — a
 * sign-out must still work for a session the server already considers stale),
 * never by anything in the body. Earlier sign-outs this browser could not
 * confirm ride along in the retry ticket and are retried here too.
 *
 * A read-only or controlled support session may call this: ending your own
 * session only ever removes access (`isSupportSessionExitRequest`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;
  const ticketCookie = request.cookies.get(LOGOUT_RETRY_COOKIE)?.value;
  const pending = await readLogoutRetryTicket(ticketCookie);

  const stillPending: PendingRevocation[] = [];
  let outcome: LogoutOutcome;
  const current = session ? pendingRevocationFor(session) : null;

  if (!session) {
    outcome = "no_session";
  } else if (!current) {
    outcome = "already_ended";
  } else {
    const result = await endPendingRevocation(current, "sign_out", request.headers);
    if (result === "failed") {
      outcome = "unconfirmed";
      stillPending.push(current);
    } else {
      outcome = result;
    }
  }
  if (session?.nativeDeviceId) {
    const deviceId = session.nativeDeviceId;
    await withTenant(session.businessId, () =>
      clearNativeDeviceAuthStateOnSignOut(deviceId, session.businessId, session.sub),
    ).catch(() => {});
  }

  const currentKey = current ? pendingRevocationKey(current) : null;
  for (const entry of pending) {
    if (pendingRevocationKey(entry) === currentKey) continue;
    if ((await endPendingRevocation(entry, "sign_out_retry", request.headers)) === "failed") {
      stillPending.push(entry);
    }
  }

  return logoutResponse({
    outcome,
    stillPending,
    clearSessionCookie: true,
    hadTicket: Boolean(ticketCookie),
    ...(session?.imp ? { redirectTo: supportSessionReturnPath(session.businessId) } : {}),
  });
}
