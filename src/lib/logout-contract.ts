/**
 * Issue #854 follow-up — one typed answer for «خروج از حساب».
 *
 * The sign-out route used to swallow every revocation failure and answer
 * `{ ok: true }`, and its three callers read that answer three different ways:
 * the sidebar menu ignored the status, the signed-in notice called a rejected
 * request a success, and only the Profile card (F10) looked at `res.ok` at all.
 * A sign-out is a security action — "this browser is signed out, but the
 * server could not confirm the session ended" is something the member must be
 * told, and something a retry must be able to finish.
 *
 * Client-safe (types, constants, one pure reader, the Persian copy): the route
 * and every caller share this file, so they cannot drift apart again.
 *
 * ## Outcomes
 *
 *  - `revoked` — the server ended the session record and committed its audit
 *    row together; a copy of the token kept anywhere else is now refused.
 *  - `already_ended` — the record was already revoked or gone.
 *  - `not_tracked` — the session has no server-side record to end (a session
 *    minted by a business switch, setup or a desktop hand-off carries no
 *    `employeeSessionId`); clearing the browser cookie is all there is.
 *  - `no_session` — no valid session arrived, so there was nothing to end.
 *  - `unconfirmed` — the server could not confirm the end (a database or audit
 *    failure). The browser cookie is cleared anyway (that part is
 *    unconditional), and the server keeps an httpOnly retry ticket so
 *    `POST /api/auth/logout/retry` can finish the job without the cookie.
 */

export const LOGOUT_PATH = "/api/auth/logout";
export const LOGOUT_RETRY_PATH = "/api/auth/logout/retry";

export const LOGOUT_OUTCOMES = [
  "revoked",
  "already_ended",
  "not_tracked",
  "no_session",
  "unconfirmed",
] as const;
export type LogoutOutcome = (typeof LOGOUT_OUTCOMES)[number];

export const LOGOUT_UNCONFIRMED_ERROR = "logout_unconfirmed" as const;

/** What `POST /api/auth/logout` and `POST /api/auth/logout/retry` answer. */
export interface LogoutResponseBody {
  /** True only when nothing this browser asked to end is left unconfirmed. */
  ok: boolean;
  /** The session this request was about (the retry route: the pending ones). */
  outcome: LogoutOutcome;
  /**
   * Whether this response cleared the browser's session cookie. Always true
   * for `/api/auth/logout`; always false for the retry route, which must never
   * sign out a session the browser has started since.
   */
  sessionCookieCleared: boolean;
  /** Sign-outs the server still could not confirm; a retry picks them up. */
  pendingRevocations: number;
  error?: typeof LOGOUT_UNCONFIRMED_ERROR;
  message?: string;
}

/** A confirmed sign-out — everything except `unconfirmed`. */
export type ConfirmedLogoutOutcome = Exclude<LogoutOutcome, "unconfirmed">;

/** The caller's reading of one attempt. */
export type SignOutResult =
  /** Safe to leave: the server confirmed there is nothing left to end. */
  | { kind: "signed_out"; outcome: ConfirmedLogoutOutcome }
  /**
   * The browser is signed out (the server cleared the cookie), but the end of
   * the session was not confirmed. Retry with `LOGOUT_RETRY_PATH`.
   */
  | { kind: "unconfirmed"; pendingRevocations: number; sessionCookieCleared: boolean }
  /** The request never got an answer: nothing changed, the member is still signed in. */
  | { kind: "network" }
  /** An answer that is not this contract (a proxy error page, a 5xx elsewhere): treat as still signed in. */
  | { kind: "server" };

function isLogoutOutcome(value: unknown): value is LogoutOutcome {
  return typeof value === "string" && (LOGOUT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Read a sign-out answer. Pure, so the mapping is pinned by unit tests rather
 * than re-derived in three components.
 *
 * A bare `401 {"error":"unauthorized"}` is middleware saying the browser holds
 * no valid session at all — which is what "signed out" means — so it reads as
 * `no_session` instead of a failure the member could never get past.
 */
export function readLogoutResponse(status: number, body: unknown): SignOutResult {
  const data = (body && typeof body === "object" ? body : {}) as Partial<LogoutResponseBody>;
  const error = (data as { error?: unknown }).error;
  if (isLogoutOutcome(data.outcome) && typeof data.ok === "boolean") {
    const pendingRevocations =
      typeof data.pendingRevocations === "number" && data.pendingRevocations > 0
        ? data.pendingRevocations
        : 0;
    if (!data.ok || data.outcome === "unconfirmed") {
      return {
        kind: "unconfirmed",
        pendingRevocations: Math.max(pendingRevocations, 1),
        sessionCookieCleared: data.sessionCookieCleared === true,
      };
    }
    return { kind: "signed_out", outcome: data.outcome as ConfirmedLogoutOutcome };
  }
  if (status === 401 && error === "unauthorized") {
    return { kind: "signed_out", outcome: "no_session" };
  }
  return { kind: "server" };
}

/** The Persian copy every sign-out surface uses — one wording per outcome. */
export const LOGOUT_MESSAGES = {
  unconfirmed:
    "از این دستگاه خارج شدید، اما سرور پایان نشست را تأیید نکرد؛ «تلاش دوباره» را بزنید تا نشست روی سرور هم بسته شود.",
  network:
    "ارتباط با سرور برقرار نشد و خروج انجام نشد؛ نشست شما هنوز باز است. اتصال را بررسی کنید و دوباره تلاش کنید.",
  server: "خروج از حساب کامل نشد و نشست شما ممکن است هنوز باز باشد؛ دوباره تلاش کنید.",
  confirmedAfterRetry: "نشست روی سرور هم پایان یافت.",
  retryLabel: "تلاش دوباره",
} as const;

/** The message for a result that is not a clean sign-out, or null for one that is. */
export function signOutResultMessage(result: SignOutResult): string | null {
  switch (result.kind) {
    case "signed_out":
      return null;
    case "unconfirmed":
      return LOGOUT_MESSAGES.unconfirmed;
    case "network":
      return LOGOUT_MESSAGES.network;
    case "server":
      return LOGOUT_MESSAGES.server;
  }
}

/**
 * Whether the browser can be treated as signed out — the point at which a
 * caller may navigate away. `unconfirmed` qualifies only when the server says
 * it cleared the cookie (staying on a page whose session is gone helps nobody,
 * as long as the member is told the server side is unconfirmed).
 */
export function browserSignedOut(result: SignOutResult): boolean {
  return result.kind === "signed_out" || (result.kind === "unconfirmed" && result.sessionCookieCleared);
}
