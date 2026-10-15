/**
 * Issue #854 follow-up (F10 and the logout follow-up) — the one client-side
 * sign-out request whose answer is actually read.
 *
 * Every sign-out surface (the Profile card, the sidebar menu's «خروج» and
 * «تغییر حساب», the signed-in notice on /login and /admin) goes through these
 * two calls and reads the answer with the shared contract in
 * `@/lib/logout-contract`, so "the server confirmed it", "this browser is out
 * but the server could not confirm it" and "nothing happened, you are still
 * signed in" are told apart the same way everywhere.
 *
 * The request functions are plain (unit-tested with a fake `fetch`);
 * `useSignOut` below is the thin React state around them — the busy flag, the
 * last result and the right next attempt.
 */
import { useCallback, useRef, useState } from "react";
import {
  LOGOUT_PATH,
  LOGOUT_RETRY_PATH,
  readLogoutResponse,
  type SignOutResult,
} from "@/lib/logout-contract";

export type { SignOutResult } from "@/lib/logout-contract";
export {
  browserSignedOut,
  signOutDestination,
  signOutResultMessage,
  LOGOUT_MESSAGES,
} from "@/lib/logout-contract";

async function postSignOut(path: string, fetchImpl: typeof fetch): Promise<SignOutResult> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: "POST",
      credentials: "same-origin",
      // A sign-out must reach the server; never answer it from a cache.
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    // Offline, aborted, DNS: the request never got an answer, so nothing
    // changed — the cookie is still in this browser.
    return { kind: "network" };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return readLogoutResponse(res.status, body);
}

const defaultFetch: typeof fetch = (...args) => fetch(...args);

/** End this browser's session (`POST /api/auth/logout`). */
export function requestSignOut(fetchImpl: typeof fetch = defaultFetch): Promise<SignOutResult> {
  return postSignOut(LOGOUT_PATH, fetchImpl);
}

/**
 * Finish a sign-out the server could not confirm (`POST /api/auth/logout/retry`).
 * The session cookie is already gone by then; the server finds the session
 * from the httpOnly retry ticket it set, never from anything this code sends.
 */
export function retrySignOut(fetchImpl: typeof fetch = defaultFetch): Promise<SignOutResult> {
  return postSignOut(LOGOUT_RETRY_PATH, fetchImpl);
}

/**
 * The right next attempt after `previous`: once the server has cleared the
 * cookie, a second plain sign-out would find no session and report success
 * without ending anything — only the retry route can finish the job.
 */
export async function signOutAgain(
  previous: SignOutResult | null,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<SignOutResult> {
  if (previous?.kind !== "unconfirmed" || !previous.sessionCookieCleared) {
    return requestSignOut(fetchImpl);
  }
  const next = await retrySignOut(fetchImpl);
  // The retry answer never names a destination (it has no session to read
  // one from); the first answer's — a support operator's console — still holds.
  const redirect = previous.redirectTo ? { redirectTo: previous.redirectTo } : {};
  if (next.kind === "signed_out") return { ...next, ...redirect };
  // The retry did not finish it — but this browser is still signed out (its
  // cookie went with the first answer). A dropped retry is "still
  // unconfirmed", never "you are still signed in".
  return {
    kind: "unconfirmed",
    pendingRevocations:
      next.kind === "unconfirmed" ? next.pendingRevocations : previous.pendingRevocations,
    sessionCookieCleared: true,
    ...redirect,
  };
}

/**
 * React state for a sign-out button: the busy flag is released on every path
 * (including a rejected request), and each attempt picks the right route from
 * the previous result.
 */
export function useSignOut(fetchImpl: typeof fetch = defaultFetch) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SignOutResult | null>(null);
  const last = useRef<SignOutResult | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (): Promise<SignOutResult | null> => {
    // A double click must not send two sign-outs; the second one would read
    // the first one's cleared cookie as "no session".
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const next = await signOutAgain(last.current, fetchImpl);
      last.current = next;
      setResult(next);
      return next;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [fetchImpl]);

  return { busy, result, run };
}
