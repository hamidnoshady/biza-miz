/**
 * Issue #854 follow-up (F10) — one client-side sign-out request whose answer
 * is actually read.
 *
 * The Profile card used to `await fetch("/api/auth/logout")` and navigate to
 * `/login` whatever happened: a 5xx, a proxy error page or a dropped
 * connection all looked like a successful sign-out while the session stayed
 * open on the server *and* the cookie stayed in the browser. A sign-out is a
 * security action, so "it failed and you are still signed in" has to be
 * something the member is told.
 *
 * Framework-free so it can be unit-tested and reused by any sign-out button.
 */

export type SignOutFailure = "network" | "server";

export type SignOutResult = { ok: true } | { ok: false; reason: SignOutFailure };

export async function requestSignOut(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<SignOutResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      // A sign-out must reach the server; never answer it from a cache.
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  return res.ok ? { ok: true } : { ok: false, reason: "server" };
}

/** What to tell the member — both cases say plainly that they are still signed in. */
export function signOutFailureMessage(reason: SignOutFailure): string {
  return reason === "network"
    ? "ارتباط با سرور برقرار نشد و خروج انجام نشد؛ نشست شما هنوز باز است. اتصال را بررسی کنید و دوباره تلاش کنید."
    : "خروج از حساب کامل نشد و نشست شما ممکن است هنوز باز باشد؛ دوباره تلاش کنید.";
}
