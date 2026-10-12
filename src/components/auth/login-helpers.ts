"use client";

/**
 * Shared pieces of the two tenant sign-in screens.
 *
 * Since the login split, the tenant origin has two separate doors: the staff
 * quick login at `/login` (name-then-PIN, plus biometrics) and the
 * owner/manager password login at `/admin`. Both need the same two helpers —
 * where a successful sign-in should go, and how a lockout is worded — so they
 * live here instead of being duplicated (and drifting) across the two forms.
 */
import { useSearchParams } from "next/navigation";
import { toPersianDigits } from "@/lib/digits";
import { safeLoginNextPath } from "@/lib/login-contract";

/**
 * Where to go after signing in.
 *
 * `?next=` is set by middleware and by the host resolver so a deep link
 * survives the login page — Phase 34 depends on it concretely: an owner
 * following Claude's "connect" button lands on `/mcp/consent?…`, and dropping
 * that URL abandons an OAuth flow they have no way to restart from inside the
 * app.
 *
 * Only ever a same-site path, and the rule now lives in one place.
 *
 * Issue #885: this used to test `startsWith("/")` and `!startsWith("//")`
 * inline, while the desktop's `safeNextPath` tested the same two things *plus*
 * the backslash form. Two near-identical validators is how one of them ends up
 * missing a case, and `/\\evil.example` was exactly that case — browsers read
 * `\\` as `/` in an authority, so it is the same open redirect as `//…`. Both
 * now delegate to `safeLoginNextPath`, which also rejects control characters
 * and percent-encoded variants of either.
 */
export function useNextPath(fallback: string): string {
  const params = useSearchParams();
  return safeLoginNextPath(params.get("next"), fallback);
}

/**
 * A 423 (`account_locked`) from a credential exchange, worded with the concrete
 * wait time instead of the generic "wrong credentials" text — reporting a
 * lockout as "wrong password/PIN" sends the user back to re-check a credential
 * that is perfectly correct, and to keep trying, which is exactly what extends
 * the lockout.
 */
export function lockoutMessage(lockedUntil: unknown): string {
  const until = typeof lockedUntil === "string" ? new Date(lockedUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return "به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است.";
  }
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است؛ ${toPersianDigits(String(minutes))} دقیقه دیگر دوباره تلاش کنید.`;
}

/**
 * A 429's `Retry-After` in milliseconds.
 *
 * The staff picker's roster read has a per-IP ceiling (see ROSTER_IP_LIMIT in
 * src/middleware.ts) and says when it clears; waiting that long beats parking
 * the till's front screen on an error that was always going to lift by itself.
 *
 * Bounded at both ends because the header is not ours: a missing or malformed
 * value falls back to a short wait rather than never retrying, and an
 * unreasonably large one is capped so a bad response cannot leave a cashier
 * staring at a login screen that will not refresh.
 */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return 3_000;
  return Math.min(Math.max(seconds * 1_000, 1_000), 30_000);
}
