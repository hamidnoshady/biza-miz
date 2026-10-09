/**
 * Issue #885 — the client-safe login contract.
 *
 * One module that owns the rules every login consumer agrees on: where a
 * successful sign-in may go, how a typed digit string is canonicalised, how a
 * failed credential exchange is worded, and how the doors link to each other
 * without dropping the destination on the way.
 *
 * Client-safe by construction: no `next/server`, no `pg`, no `node:` imports
 * beyond what a browser bundle can carry. That is what lets the *same*
 * next-path rule run in a form and in a route handler, instead of the two
 * near-duplicates the audit found drifting — `login-helpers.useNextPath`
 * rejected `//evil.example` but not `/\\evil.example`, while the desktop's
 * `safeNextPath` rejected both. Both now delegate here.
 *
 * None of this authorises anything. A destination that survives validation is
 * still checked by the route it lands on; a code that canonicalises to six
 * digits is still verified against a challenge row. These are input rules,
 * not trust.
 */
import { toLatinDigits, toPersianDigits } from "./digits";

/**
 * Longest destination the login screens will carry.
 *
 * Generous enough for a deep link with a query string, short enough that a
 * pasted megabyte cannot be reflected into a redirect or a cookie.
 */
export const MAX_LOGIN_NEXT_LENGTH = 2048;

/**
 * The canonical "is this a safe same-site destination?" rule.
 *
 * Returns `fallback` for anything that is not a relative path on this origin.
 * The cases, in the order they are checked:
 *
 *  - not a string, empty, or overlong — nothing to honour;
 *  - contains a control character. Browsers strip tab and newline out of a
 *    URL before parsing it, so `"/\t/evil.example"` reaches the address bar
 *    as the protocol-relative `"//evil.example"`. Rejecting the character is
 *    the only way to be sure;
 *  - does not start with `/` — an absolute `https://…` or a bare
 *    `evil.example`;
 *  - contains a backslash anywhere. Browsers treat `\` as `/` in the
 *    authority, so `/\evil.example` is the same open redirect as `//…`. No
 *    route in this app contains a backslash, so the blanket rejection costs
 *    nothing;
 *  - still unsafe after one percent-decode. `/%2F%2Fevil.example` is a path
 *    here and a protocol-relative URL the moment anything decodes it.
 *
 * The decoded form is only ever *tested*, never returned: the caller gets
 * back exactly what it passed in, so a route cannot be surprised by a value
 * that differs from the one it validated.
 */
export function safeLoginNextPath(
  raw: unknown,
  fallback = "/",
): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || value.length > MAX_LOGIN_NEXT_LENGTH) return fallback;

  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.includes("\\")) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed escape sequence is not a destination anyone meant.
    return fallback;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
    return fallback;
  }
  return value;
}

/** Is `raw` a destination this login may navigate to? */
export function isSafeLoginNextPath(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim() !== "" && safeLoginNextPath(raw, "") === raw.trim();
}

/**
 * Append a validated `?next=` to a path, or return the path untouched.
 *
 * This is the whole of issue #885 L06: the chooser navigated to a hard-coded
 * `/admin`, the "back to staff" button to a hard-coded `/login`, and the host
 * aliases to their canonical path with no query — so
 * `/login?next=/settings/profile` lost the destination the moment the user
 * changed their mind about which door to use. Every inter-door link goes
 * through here now, and the parameter that survives is the one
 * `safeLoginNextPath` already approved.
 */
export function withLoginNextParam(
  path: string,
  next: unknown,
): string {
  const safe = safeLoginNextPath(next, "");
  if (!safe) return path;
  const [base, queryString = ""] = path.split("?");
  const params = new URLSearchParams(queryString);
  // Never carry a destination that is the page itself; that is a loop, not a
  // deep link.
  if (safe === base) return path;
  params.set("next", safe);
  const encoded = params.toString();
  return encoded ? `${base}?${encoded}` : base;
}

/**
 * Canonicalise a typed one-time code.
 *
 * Issue #885 L11: the OTP field ran `replace(/\D/g, "")`, which deletes
 * Persian and Arabic-Indic digits outright — a member typing on a Persian
 * keyboard saw their input vanish, and the server's `/^\d{6}$/` would have
 * rejected it anyway. Normalising first and filtering second means the same
 * six digits are accepted whichever keyboard produced them.
 *
 * Applied at both boundaries: the input's `onChange` (so the field shows the
 * digits, not blanks) and the server's validation (so a client that skips the
 * first still cannot smuggle anything through).
 */
export function normalizeOtpCode(raw: unknown, maxLength = 6): string {
  if (typeof raw !== "string") return "";
  return toLatinDigits(raw).replace(/\D/g, "").slice(0, maxLength);
}

/** Canonicalise a typed PIN: any keyboard's digits, ASCII out, bounded. */
export function normalizePinInput(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") return "";
  return toLatinDigits(raw).replace(/\D/g, "").slice(0, maxLength);
}

/**
 * A string field, bounded and trimmed, or null.
 *
 * Issue #885 L14: the password route checked truthiness and then called
 * `.trim()` on the value, so a truthy non-string (`{"password": 123}`, or an
 * array from a form-encoder) reached string methods and bcrypt and threw a
 * 500 instead of answering 400. Every untrusted string field on the login
 * paths goes through this now, which is also where the length ceiling lives —
 * bcrypt in particular is only defined for 72 bytes and should be told about
 * a longer input rather than silently truncating it.
 */
export function boundedString(
  raw: unknown,
  options: { max: number; required?: boolean; trim?: boolean } ,
): string | null {
  if (typeof raw !== "string") return null;
  const value = options.trim === false ? raw : raw.trim();
  if (options.required !== false && value === "") return null;
  if (value.length > options.max) return null;
  return value;
}

/** A canonical UUID string, or null. Login bodies name rows by id. */
export function uuidOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

/** An email address, lower-cased and bounded, or null. */
export function loginEmailOrNull(raw: unknown, max = 254): string | null {
  const value = boundedString(raw, { max });
  if (!value) return null;
  const email = value.toLowerCase();
  // Deliberately a shape check, not a validation suite: the password
  // comparison is what decides, and a stricter pattern here would only move
  // "wrong credentials" earlier for an address that was never going to match.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Which door the login screens are showing, as the storage records it.
 *
 * Exported from here rather than `login-door.ts` so the contract module stays
 * the single place that knows the vocabulary; `login-door.ts` keeps the
 * localStorage mechanics.
 */
export type LoginDoorName = "admin" | "staff";

/**
 * The safe, localized wording for a failed credential exchange.
 *
 * Issue #885 L09: the manager form mapped every non-423 response to "wrong
 * email or password", which told the truth about one case and lied about six
 * others — a spent rate limit, a wrong-origin request, a business that is not
 * available, a missing membership and a server fault all read as a typo, and
 * each of them sends the user to re-type a credential that was never the
 * problem.
 *
 * The anti-enumeration rule is preserved exactly: nothing here distinguishes
 * "no such account" from "wrong password". Both are `invalid_credentials`,
 * and the caller gets the same sentence either way.
 */
export function loginErrorMessage(options: {
  status: number;
  code?: string | null;
  retryAfterMs?: number | null;
}): string {
  const { status, code } = options;

  if (status === 429) {
    const ms = typeof options.retryAfterMs === "number" && options.retryAfterMs > 0
      ? options.retryAfterMs
      : 60_000;
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return `تعداد تلاش‌ها زیاد است؛ حدود ${toPersianDigits(minutes)} دقیقهٔ دیگر دوباره تلاش کنید.`;
  }

  switch (code) {
    case "account_locked":
      // The caller is expected to prefer lockoutMessage() for a 423, which
      // carries the exact unlock time; this is the fallback when it did not.
      return "به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است.";
    case "wrong_origin":
      return "این نشانی به این کسب‌وکار تعلق ندارد. از نشانی درست کسب‌وکار خود وارد شوید.";
    case "business_unavailable":
    case "unknown_business":
    case "business_required":
      return "کسب‌وکار در دسترس نیست. با مدیر خود تماس بگیرید.";
    case "no_membership":
      return "برای این حساب دسترسی فعالی ثبت نشده است.";
    case "needsBusinessSelection":
      return "برای ادامه، کسب‌وکار خود را انتخاب کنید.";
    case "bad_request":
    case "invalid_email":
    case "invalid_credentials":
    case "invalid_pin":
    case "invalid_phone":
    case "invalid_code":
      return "ایمیل یا رمز عبور نادرست است.";
    case "sms_dispatch_failed":
      return "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.";
    case "unauthorized":
      return "مهلت این مرحله تمام شده است؛ از ابتدا تلاش کنید.";
    default:
      break;
  }

  if (status === 400) return "درخواست معتبر نیست. لطفاً ورودی‌ها را بررسی کنید.";
  if (status === 401) return "ایمیل یا رمز عبور نادرست است.";
  if (status === 403) return "اجازهٔ ورود از این مسیر داده نشده است.";
  if (status === 502 || status === 503 || status === 504) {
    return "سرویس موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.";
  }
  if (status >= 500) return "خطای سرور رخ داد. کمی بعد دوباره تلاش کنید.";
  return "ورود ناموفق بود. دوباره تلاش کنید.";
}
