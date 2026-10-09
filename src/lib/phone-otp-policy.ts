/**
 * Phase 42 — the phone-OTP login policy, pure part.
 *
 * Mirrors mfa.ts/mfa-policy.ts on purpose: the rules are unit-testable
 * without a database, and the one read that needs Postgres lives beside them
 * in getPhoneOtpPolicy below (same split, same reason as mfa-policy.ts).
 *
 * Three rules, in one place:
 *
 *  1. **Enforcement has an adoption date.** A business is inside its window
 *     until `enforcedAt`, and the PIN door behaves exactly as before during
 *     it — businesses are running on this install today, and a security
 *     feature that locks the till on deploy day is a outage with a badge.
 *     Existing businesses were stamped `now() + 14 days` by migration 0139;
 *     businesses created after it are stamped `now` by provisionBusiness.
 *  2. **Enforcement needs SMS.** With no Kavenegar key configured (a local,
 *     offline install), no OTP can be delivered, so the requirement pauses as
 *     `pending_sms` rather than becoming a lockout with a friendlier name.
 *  3. **The PIN is a 7-day shortcut, not a second login.** A member may sign
 *     in with PIN alone only within 7 days of their last successful phone-OTP
 *     verification (`users.otp_login_at`). After that the door asks for the
 *     OTP again — same day, every 7 days — which is what "login with your
 *     phone, PIN for a week after" means.
 */

/** How long after an OTP verification the PIN alone still opens the door. */
export const PIN_WINDOW_DAYS = 7;
/** The adoption window migration 0139 stamps for businesses already running. */
export const PHONE_OTP_GRACE_DAYS = 14;

export const PIN_WINDOW_MS = PIN_WINDOW_DAYS * 86_400_000;

export type PhoneOtpEnforcement = "off" | "grace" | "pending_sms" | "enforced";

export interface PhoneOtpPolicy {
  /** ISO timestamp — the date from which the phone door is mandatory. */
  enforcedAt: string | null;
}

export const DEFAULT_PHONE_OTP_POLICY: PhoneOtpPolicy = { enforcedAt: null };

export function normalizePhoneOtpPolicy(value: unknown): PhoneOtpPolicy {
  if (!value || typeof value !== "object") return { ...DEFAULT_PHONE_OTP_POLICY };
  const raw = (value as Record<string, unknown>).enforcedAt;
  // Only a string that actually parses as a date counts; anything else is an
  // absent date, never a guess (a typo'd "soon" must not read as enforced).
  return {
    enforcedAt: typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : null,
  };
}

/**
 * Which side of the window a business is on.
 *
 * `smsConfigured` is passed in rather than read here so the pure rule stays
 * testable; the caller reads it with getPublicSmsConfig() once per login.
 */
export function phoneOtpEnforcement(
  policy: PhoneOtpPolicy,
  smsConfigured: boolean,
  now: Date = new Date(),
): PhoneOtpEnforcement {
  if (!policy.enforcedAt) return "off";
  const enforcedAt = new Date(policy.enforcedAt);
  if (Number.isNaN(enforcedAt.getTime())) return "off";
  if (enforcedAt.getTime() > now.getTime()) return "grace";
  // The date has passed but no OTP could be delivered — the requirement is
  // real but unenforceable, so it waits rather than locking everyone out.
  return smsConfigured ? "enforced" : "pending_sms";
}

/** Whole days left of the adoption window, rounded up, floored at zero. */
export function phoneOtpDaysRemaining(
  policy: PhoneOtpPolicy,
  now: Date = new Date(),
): number | null {
  if (!policy.enforcedAt) return null;
  const enforcedAt = new Date(policy.enforcedAt);
  if (Number.isNaN(enforcedAt.getTime())) return null;
  return Math.max(0, Math.ceil((enforcedAt.getTime() - now.getTime()) / 86_400_000));
}

/**
 * Whether the PIN shortcut is open — a verified phone *and* an OTP
 * verification inside the window. `null` (never verified) and a stale stamp
 * read the same way: the door wants the OTP again.
 */
export function pinWindowActive(otpLoginAt: Date | string | null, now: Date = new Date()): boolean {
  if (!otpLoginAt) return false;
  const at = otpLoginAt instanceof Date ? otpLoginAt : new Date(otpLoginAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < PIN_WINDOW_MS;
}

/** The three states a member's phone can be in, as the roster reports them. */
export type MemberPhoneState = "none" | "unverified" | "verified";

export function memberPhoneState(
  phoneE164: string | null,
  phoneVerifiedAt: Date | string | null,
): MemberPhoneState {
  if (!phoneE164) return "none";
  return phoneVerifiedAt ? "verified" : "unverified";
}

/**
 * How the login door should greet a member after they pick their name:
 *
 *  - `"pin"` — the PIN pad (and biometrics) as today: either the requirement
 *    is not yet enforced, or the phone is verified and the 7-day window is
 *    open. The classic quick login.
 *  - `"otp"` — straight to the OTP screen: the phone is on file (verified or
 *    not) but the window is closed or the number unproven. Entering the code
 *    proves possession — and verifies the number the first time.
 *  - `"pin_then_otp"` — no phone on file. The PIN still proves *who*, so it
 *    is asked for first; only then does the member type and verify a number.
 *    (Without the PIN first, "pick a name, type any number" would be an
 *    account takeover with extra steps.)
 */
export type EmployeeLoginMode = "pin" | "otp" | "pin_then_otp";

export function employeeLoginMode(options: {
  enforcement: PhoneOtpEnforcement;
  phoneState: MemberPhoneState;
  pinWindow: boolean;
}): EmployeeLoginMode {
  const enforced = options.enforcement === "enforced";
  if (!enforced) return "pin";
  if (options.phoneState === "none") return "pin_then_otp";
  if (options.phoneState === "verified" && options.pinWindow) return "pin";
  return "otp";
}

// ---------------------------------------------------------------------------
// The send budget — pure decision, DB-free
// ---------------------------------------------------------------------------
//
// Split out of reserveOtpSend (phone-otp.ts) because the part that is
// worth pinning down with a test is the arithmetic, not the SELECT: given the
// recent send timestamps, is one more allowed, and if not, when is it?
//
// Issue #885 L03 is about *when* this decision is taken, not what it says —
// the caller used to read the budget, compare, and only record the send on
// the way back, so two simultaneous requests both read "under the limit" and
// both spent a message. That is fixed by reserveOtpSend taking the check and
// the record inside one transaction behind an advisory lock; this function is
// the unchanged rule that decision now applies atomically.

/** One ceiling: at most `max` sends inside any rolling `windowMs`. */
export interface OtpSendLimit {
  max: number;
  windowMs: number;
}

/**
 * The three ceilings, tightest first.
 *
 * One a minute is the "I lost the SMS" resend; five an hour is the shift that
 * keeps losing it; twenty a day is the outer cap on what one membership can
 * cost. Deliberately per-membership, not per-IP — the per-IP ceiling is the
 * middleware's job (see the phone-OTP entries in AUTH_RATE_LIMITED_PATHS).
 */
export const PHONE_OTP_SEND_LIMITS: readonly OtpSendLimit[] = [
  { max: 1, windowMs: 60_000 },
  { max: 5, windowMs: 3_600_000 },
  { max: 20, windowMs: 86_400_000 },
];

export type OtpSendBudgetDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/**
 * Is one more send allowed right now?
 *
 * `sentAt` is the membership's recent send timestamps, in any order; they are
 * sorted here so a caller cannot get the answer wrong by passing them
 * ascending. The refusal names the soonest instant the tightest breached
 * ceiling clears — which is when the oldest send inside that window ages out
 * of it, not a fixed cool-down, because a fixed one would be wrong in both
 * directions for a member who has been sending steadily.
 */
export function otpSendBudgetDecision(
  sentAt: ReadonlyArray<Date | string | number>,
  now: Date = new Date(),
  limits: readonly OtpSendLimit[] = PHONE_OTP_SEND_LIMITS,
): OtpSendBudgetDecision {
  const reference = now.getTime();
  const times = sentAt
    .map((value) => new Date(value).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => b - a);

  for (const limit of limits) {
    const inside = times.filter((ms) => reference - ms < limit.windowMs);
    if (inside.length < limit.max) continue;
    // `inside` is still newest-first, so the last element is the oldest send
    // holding this window closed.
    const oldest = inside[inside.length - 1];
    return {
      allowed: false,
      retryAfterMs: Math.max(0, limit.windowMs - (reference - oldest)),
    };
  }
  return { allowed: true };
}
