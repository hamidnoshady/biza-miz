/**
 * Phase 46 — «ورود با حساب ابری»: one-click sign-in on a paired desktop.
 *
 *   1. The desktop's login screen asks its local server for a `state`
 *      (kept in an httpOnly cookie) and opens the cloud's /desktop-login
 *      page in the system browser — where the owner may already be signed in.
 *   2. The cloud mints a single-use *device* code for that paired install and
 *      hands the browser back with businesssuite://cloud-login?code&state.
 *   3. Electron passes it to the local server, which checks `state` against
 *      its cookie and redeems the code server-to-server with the install's
 *      bearer credential. The cloud answers which member it was, and a
 *      single-use *session* code for the embedded cloud pane.
 *   4. The desktop signs that member in locally (IAM-synced users share their
 *      id) and the pane redeems the session code on the business's origin.
 *
 * Framework-free and unit-tested; the DB half is desktop-cloud-login-service.ts.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { safeLoginNextPath } from "./login-contract";

export const LOGIN_PROTOCOL = "businesssuite";
/** Both codes live two minutes: long enough to switch windows, short enough to be useless later. */
export const LOGIN_CODE_TTL_SECONDS = 120;
/** The desktop's cookie names. */
export const CLOUD_LOGIN_STATE_COOKIE = "cloud_login_state";
export const CLOUD_SESSION_CODE_COOKIE = "cloud_session_code";

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function newLoginToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isLoginToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function hashLoginCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time comparison of the link's `state` with the desktop's cookie. */
export function statesMatch(fromLink: string | null, fromCookie: string | undefined): boolean {
  if (!isLoginToken(fromLink) || !isLoginToken(fromCookie)) return false;
  const a = Buffer.from(fromLink);
  const b = Buffer.from(fromCookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function desktopLoginLink(code: string, state: string): string {
  const link = new URL(`${LOGIN_PROTOCOL}://cloud-login`);
  link.searchParams.set("code", code);
  link.searchParams.set("state", state);
  return link.toString();
}

/** The cloud page the desktop opens in the system browser. */
export function cloudLoginPageUrl(remoteUrl: string, state: string, devicePublicId: string): string | null {
  try {
    const url = new URL("/desktop-login", remoteUrl);
    if (url.protocol !== "https:") return null;
    url.searchParams.set("state", state);
    url.searchParams.set("device", devicePublicId);
    return url.toString();
  } catch {
    return null;
  }
}

/** A same-origin path to land on after a hand-off; never another host (`//x`, `/\x`, `https:`). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  // Issue #885 — delegates to the one canonical validator rather than keeping
  // a second copy of the rule. This copy was the *stricter* of the two (it
  // also rejected the backslash authority form the tenant doors missed), so
  // consolidating only widens what the others reject; nothing that used to
  // pass here changes.
  return safeLoginNextPath(next, fallback);
}
