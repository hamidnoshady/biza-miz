import { NextResponse, type NextRequest } from "next/server";
import type { LogoutOutcome } from "@/lib/logout-contract";
import { LOGOUT_RETRY_COOKIE, readLogoutRetryTicket, type PendingRevocation } from "@/lib/logout-retry";
import { endPendingRevocation, logoutResponse } from "@/lib/logout-service";

/**
 * Finish a sign-out the server could not confirm (#854 follow-up).
 *
 * `POST /api/auth/logout` clears the session cookie on every answer, so when
 * ending the session's row failed, nothing left in the browser names that
 * session — except the httpOnly retry ticket the route set
 * (`@/lib/logout-retry`). This route reads that ticket and only that ticket:
 * it takes no body, ends only the sessions the ticket's signed entries name
 * (each restricted to its own member's row, or to its own operator's support
 * grant), and never touches the session cookie — a member who has signed in
 * again since must not be signed out by a stale retry.
 *
 * Reachable without a session (middleware's public list, with the Origin
 * mismatch check the sign-in mutations get): the cookie it would need is
 * exactly what the first answer cleared.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ticketCookie = request.cookies.get(LOGOUT_RETRY_COOKIE)?.value;
  const pending = await readLogoutRetryTicket(ticketCookie);

  const stillPending: PendingRevocation[] = [];
  let revokedAny = false;
  for (const entry of pending) {
    const result = await endPendingRevocation(entry, "sign_out_retry", request.headers);
    if (result === "failed") stillPending.push(entry);
    else if (result === "revoked") revokedAny = true;
  }

  const outcome: LogoutOutcome =
    pending.length === 0
      ? "no_session"
      : stillPending.length > 0
        ? "unconfirmed"
        : revokedAny
          ? "revoked"
          : "already_ended";

  return logoutResponse({
    outcome,
    stillPending,
    clearSessionCookie: false,
    hadTicket: Boolean(ticketCookie),
  });
}
