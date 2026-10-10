/**
 * Issue #854 (P1.9 / P1.19 / P2.17 / P2.23) — the shared request/response
 * vocabulary for the auth surfaces.
 *
 * The findings this closes were all the same shape: a client and a server (or
 * two clients of the same server) had each invented their own field names for
 * one conversation, and the mismatch failed *quietly*.
 *
 *  - `TwoFactorSettings` posted `{ mfaCode }`; `/api/auth/step-up` read
 *    `{ code }`. The step-up form therefore never worked for a TOTP user — the
 *    route answered `missing_credentials` and the UI blamed the password.
 *  - The Profile session card posted `{ action: "revoke_one" }` with `DELETE`;
 *    the tenant route implemented `POST` only.
 *  - Password error codes drifted: the UI translated `password_blank`,
 *    `missing_current_password` and `password_confirmation_mismatch`, and the
 *    API emitted `missing_fields`. A user saw the generic fallback sentence for
 *    a condition the UI had a perfectly good message for.
 *  - The multi-business login response (`needsBusinessSelection`) existed on the
 *    wire but no screen finished the conversation.
 *
 * Everything here is *pure* — no `node:`, no `next/server`, no database — so a
 * `"use client"` component and a route handler can both import it. That is the
 * precondition for the two ends actually agreeing.
 */

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/**
 * The canonical auth error codes.
 *
 * Named as a frozen object rather than a bare union so the emitting route and
 * the translating UI reference the same spelling. `AUTH_ERROR_CODES.all ===
 * "all"` is compile-time-checked against nothing at all — it is the *const*
 * object that is the source of truth, and `AuthErrorCode` is derived from it,
 * so adding a code in one place adds it in both.
 */
export const AUTH_ERROR_CODES = {
  // Request shape
  badRequest: "bad_request",
  missingFields: "missing_fields",
  missingCredentials: "missing_credentials",
  missingCode: "missing_code",
  missingToken: "missing_token",
  invalidAction: "invalid_action",
  invalidMethod: "invalid_method",

  // Password
  missingCurrentPassword: "missing_current_password",
  invalidCurrentPassword: "invalid_current_password",
  passwordConfirmationMismatch: "password_confirmation_mismatch",
  passwordBlank: "password_blank",
  passwordTooShort: "password_too_short",
  passwordTooLong: "password_too_long",
  passwordUnchanged: "password_unchanged",
  crossUserPasswordResetForbidden: "cross_user_password_reset_forbidden",
  loginManagedByCloud: "login_managed_by_cloud",

  // Codes and challenges
  invalidCode: "invalid_code",
  invalidPin: "invalid_pin",
  invalidCurrentPin: "invalid_current_pin",
  currentPinRequired: "current_pin_required",
  pinMissing: "pin_missing",
  pinConfirmationMismatch: "pin_confirmation_mismatch",
  pinTaken: "pin_taken",
  pinUnchanged: "pin_unchanged",
  invalidPhone: "invalid_phone",
  phoneTaken: "phone_taken",
  phoneMissing: "phone_missing",
  codeWrongPhone: "code_wrong_phone",
  challengeExpired: "challenge_expired",
  challengeSent: "challenge_sent",
  selectionExpired: "selection_expired",
  alreadyEnrolled: "already_enrolled",
  notEnrolled: "not_enrolled",
  unknownAction: "unknown_action",
  noLogin: "no_login",
  challengeConsumed: "challenge_consumed",
  attemptsExhausted: "attempts_exhausted",
  rateLimited: "rate_limited",
  smsDispatchFailed: "sms_dispatch_failed",

  // Authorization / escalation
  forbidden: "forbidden",
  ownerOnly: "owner_only",
  permissionsManageRequired: "permissions_manage_required",
  grantsBeyondActor: "grants_beyond_actor",
  selfRoleChange: "self_role_change",
  customRoleNotFound: "custom_role_not_found",
  customRoleBeyondActor: "custom_role_beyond_actor",
  notFound: "not_found",

  // Recent auth / MFA
  recentAuthRequired: "recent_auth_required",
  mfaRequired: "mfa_required",
  mfaDistinctFactorRequired: "mfa_distinct_factor_required",
  accountLocked: "account_locked",
  cannotRemoveLastFactor: "cannot_remove_last_factor",

  // Session / deployment
  unauthorized: "unauthorized",
  sessionNotFound: "session_not_found",
  nothingToChange: "nothing_to_change",
  notAValueThisDeploymentOwns: "not_a_value_this_deployment_owns",
  noVerifiedChannel: "no_verified_channel",
  cloudConfirmationRequired: "cloud_confirmation_required",
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Persian message for an auth error code.
 *
 * One table, used by every Profile / Team / login surface. The alternative —
 * each component keeping its own `Record<string, string>` — is what produced
 * P2.17: three maps that had drifted, and a server that emitted codes none of
 * them knew.
 */
const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  bad_request: "درخواست نامعتبر است.",
  missing_fields: "همهٔ فیلدهای لازم را پر کنید.",
  missing_credentials: "اطلاعات ورود را کامل وارد کنید.",
  missing_code: "کد تأیید را وارد کنید.",
  missing_token: "نشانی بازیابی نامعتبر است.",
  invalid_action: "درخواست نامعتبر است.",
  invalid_method: "روش انتخاب‌شده معتبر نیست.",

  missing_current_password: "رمز عبور فعلی را وارد کنید.",
  invalid_current_password: "رمز عبور فعلی نادرست است.",
  password_confirmation_mismatch: "تکرار رمز عبور جدید با رمز جدید یکسان نیست.",
  password_blank: "رمز عبور نمی‌تواند فقط فاصله باشد.",
  password_too_short: "رمز عبور جدید باید حداقل ۸ نویسه باشد.",
  password_too_long: "رمز عبور جدید بیش از حد طولانی است.",
  password_unchanged: "رمز عبور جدید باید با رمز فعلی متفاوت باشد.",
  cross_user_password_reset_forbidden:
    "تعیین رمز عبور برای کاربر دیگر مجاز نیست؛ فرایند بازیابی را برای خودش آغاز کنید.",
  login_managed_by_cloud: "این مورد در نسخهٔ ابری مدیریت می‌شود.",

  invalid_code: "کد ۶ رقمی واردشده نادرست است.",
  invalid_pin: "رمز عددی معتبر نیست.",
  invalid_current_pin: "رمز عددی فعلی نادرست است.",
  current_pin_required: "برای تغییر رمز عددی، ابتدا رمز عددی فعلی را وارد کنید.",
  pin_missing: "رمز عددی جدید را وارد کنید.",
  pin_confirmation_mismatch: "تکرار رمز عددی جدید با رمز جدید یکسان نیست.",
  pin_taken: "این رمز عددی برای عضو دیگری در همین کسب‌وکار ثبت شده است؛ رمز دیگری انتخاب کنید.",
  pin_unchanged: "رمز عددی جدید باید با رمز فعلی متفاوت باشد.",
  invalid_phone: "شمارهٔ موبایل معتبر نیست.",
  phone_taken: "این شماره قبلاً برای عضو دیگری ثبت شده است.",
  phone_missing: "شمارهٔ موبایل را وارد کنید.",
  code_wrong_phone:
    "کد ارسال‌شده برای شمارهٔ دیگری است؛ شماره را تغییر ندهید و کد را دوباره درخواست کنید.",
  challenge_expired: "زمان کد تأیید به پایان رسیده است؛ کد تازه‌ای درخواست کنید.",
  challenge_sent: "کد تأیید ارسال شد.",
  selection_expired: "مهلت انتخاب کسب‌وکار به پایان رسیده است؛ دوباره وارد شوید.",
  already_enrolled: "این روش ورود دومرحله‌ای قبلاً فعال شده است.",
  not_enrolled: "این روش ورود دومرحله‌ای فعال نیست.",
  unknown_action: "درخواست نامعتبر است.",
  no_login: "برای این عضو حساب کاربری رمز عبوری ثبت نشده است.",
  challenge_consumed: "این کد قبلاً استفاده شده است؛ کد تازه‌ای درخواست کنید.",
  attempts_exhausted: "تعداد تلاش‌های ناموفق بیش از حد مجاز است؛ کد تازه‌ای درخواست کنید.",
  rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی صبر کنید.",
  sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",

  forbidden: "شما اجازهٔ این کار را ندارید.",
  owner_only: "فقط مالک کسب‌وکار می‌تواند این کار را انجام دهد.",
  permissions_manage_required: "برای تغییر نقش یا دسترسی‌ها، مجوز «مدیریت دسترسی‌های تیم» لازم است.",
  grants_beyond_actor: "نمی‌توانید دسترسی‌ای بدهید که خودتان آن را ندارید.",
  self_role_change: "تغییر نقش خودتان مجاز نیست؛ از مالک کسب‌وکار بخواهید.",
  custom_role_not_found: "نقش سفارشی انتخاب‌شده در این کسب‌وکار فعال نیست.",
  custom_role_beyond_actor: "این نقش سفارشی دسترسی‌هایی دارد که شما ندارید.",
  not_found: "موردی یافت نشد.",

  recent_auth_required: "برای انجام این تغییر امنیتی، ابتدا هویت خود را مجدداً تأیید کنید.",
  mfa_required: "ورود دومرحله‌ای برای این حساب لازم است.",
  mfa_distinct_factor_required:
    "کد پیامکی ورود نمی‌تواند هم‌زمان عامل دوم باشد؛ از برنامهٔ احرازکننده یا کد بازیابی استفاده کنید.",
  account_locked: "حساب موقتاً قفل شده است؛ کمی بعد دوباره تلاش کنید.",
  cannot_remove_last_factor:
    "ورود دومرحله‌ای برای نقش شما اجباری است؛ پیش از حذف این روش، روش دیگری را فعال کنید.",

  unauthorized: "برای ادامه باید وارد شوید.",
  session_not_found: "نشست موردنظر یافت نشد.",
  nothing_to_change: "موردی برای تغییر ارسال نشده است.",
  not_a_value_this_deployment_owns: "این مورد در نسخهٔ ابری مدیریت می‌شود.",
  no_verified_channel:
    "برای این کاربر شمارهٔ موبایل تأییدشده‌ای ثبت نشده است؛ بازیابی رمز عبور بدون کانال تأییدشده امکان‌پذیر نیست.",
  cloud_confirmation_required:
    "این تغییر باید از نسخهٔ ابری انجام شود؛ در نسخهٔ محلی فقط محدودسازی مجاز است.",
};

/** Translate an error code, falling back to a generic sentence for unknowns. */
export function authErrorMessage(code: string | undefined | null): string {
  if (!code) return "خطای غیرمنتظره. دوباره تلاش کنید.";
  return (
    AUTH_ERROR_MESSAGES[code as AuthErrorCode] ?? "خطای غیرمنتظره. دوباره تلاش کنید."
  );
}

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && value in AUTH_ERROR_MESSAGES;
}

// ---------------------------------------------------------------------------
// Business selection (P1.19)
// ---------------------------------------------------------------------------

export interface BusinessChoice {
  id: string;
  name: string;
}

/**
 * The response a multi-business identity gets before it can be signed in.
 *
 * Issued by password login, phone OTP login and cloud login alike, and consumed
 * by one shared client state (`useBusinessSelection`). The defect (#854 P1.19)
 * was that the backend produced this shape and no screen finished the
 * conversation — the member was left on a spinner with a perfectly good list in
 * the response body.
 */
export interface NeedsBusinessSelection {
  needsBusinessSelection: true;
  businesses: BusinessChoice[];
  /** Opaque token carrying "primary auth already happened, business not chosen". */
  selectionToken?: string;
}

export function isNeedsBusinessSelection(
  value: unknown,
): value is NeedsBusinessSelection {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return raw.needsBusinessSelection === true && Array.isArray(raw.businesses);
}

// ---------------------------------------------------------------------------
// Step-up (P1.6 / P1.9 / P1.10)
// ---------------------------------------------------------------------------

/**
 * Every way a member may re-prove themselves for a sensitive action.
 *
 * One union, because the alternative is what the old step-up route did: accept
 * a bare `password` string and *silently default the method to TOTP* when a
 * code came in, so an SMS-MFA user could never satisfy a step-up and a TOTP
 * user's code was checked against the wrong factor.
 */
export const STEP_UP_METHODS = [
  /** The account's global password. */
  "password",
  /** A code from the authenticator app. */
  "totp",
  /** A code texted to the confirmed SMS factor. */
  "sms_otp",
  /** A single-use recovery code. */
  "recovery",
  /** The member's current staff PIN — the only door a PIN-only role has. */
  "pin",
  /** A fresh WebAuthn assertion. */
  "webauthn",
] as const;

export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

export function isStepUpMethod(value: unknown): value is StepUpMethod {
  return typeof value === "string" && (STEP_UP_METHODS as readonly string[]).includes(value);
}

export interface StepUpRequest {
  method: StepUpMethod;
  /**
   * The secret being offered: a password, a 6-digit code, a recovery code or a
   * PIN. For `webauthn` this is the assertion payload's JSON, which is why the
   * field is not called `code` — the old name is exactly what broke the
   * contract (#854 P1.9).
   */
  credential: string;
  /** Explicit pool selection; the server refuses a method the account lacks. */
  recovery?: boolean;
  /** Set for `webauthn` — the challenge token issued by the step-up options route. */
  challengeToken?: string;
}

export type StepUpParseError =
  | "invalid_method"
  | "missing_credentials"
  | "unsupported_method";

export type StepUpParseResult =
  | { ok: true; request: StepUpRequest }
  | { ok: false; error: StepUpParseError };

/**
 * Parse a step-up request body.
 *
 * Shared by the tenant and platform routes so the two realms cannot drift, and
 * deliberately strict about the method: an absent or unknown method is refused
 * rather than defaulted. Defaulting to TOTP is what made SMS step-up
 * impossible, and "guess what the caller meant" is not a thing an
 * authentication endpoint should do.
 */
export function parseStepUpRequest(body: unknown): StepUpParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_method" };
  const raw = body as Record<string, unknown>;

  if (!isStepUpMethod(raw.method)) return { ok: false, error: "invalid_method" };

  const credential =
    typeof raw.credential === "string"
      ? raw.credential
      : typeof raw.code === "string"
        ? raw.code
        : "";
  if (!credential.trim()) return { ok: false, error: "missing_credentials" };

  return {
    ok: true,
    request: {
      method: raw.method,
      credential: credential.trim(),
      ...(raw.recovery === true ? { recovery: true } : {}),
      ...(typeof raw.challengeToken === "string" ? { challengeToken: raw.challengeToken } : {}),
    },
  };
}

/** The client-side body builder, so a form cannot invent a field name. */
export function stepUpBody(input: {
  method: StepUpMethod;
  credential: string;
  recovery?: boolean;
  challengeToken?: string;
}): string {
  return JSON.stringify({
    method: input.method,
    credential: input.credential,
    ...(input.recovery ? { recovery: true } : {}),
    ...(input.challengeToken ? { challengeToken: input.challengeToken } : {}),
  });
}

/**
 * Which step-up methods a member can actually offer, given what they hold.
 *
 * The Profile step-up picker renders exactly this list, so it never offers a
 * door the server will refuse — and, symmetrically, never hides the one the
 * member actually has (#854 P1.6: PIN-only staff were shown a password box for
 * an account that has no password).
 */
export interface StepUpAvailability {
  hasPassword: boolean;
  hasPin: boolean;
  hasTotp: boolean;
  hasSms: boolean;
  hasRecoveryCodes: boolean;
  hasWebauthn: boolean;
}

export function availableStepUpMethods(availability: StepUpAvailability): StepUpMethod[] {
  const methods: StepUpMethod[] = [];
  if (availability.hasPassword) methods.push("password");
  if (availability.hasTotp) methods.push("totp");
  if (availability.hasSms) methods.push("sms_otp");
  if (availability.hasPin) methods.push("pin");
  if (availability.hasWebauthn) methods.push("webauthn");
  if (availability.hasRecoveryCodes) methods.push("recovery");
  return methods;
}

/** Persian label for the picker. */
export function stepUpMethodLabel(method: StepUpMethod): string {
  switch (method) {
    case "password":
      return "رمز عبور";
    case "totp":
      return "کد برنامهٔ احرازکننده";
    case "sms_otp":
      return "کد پیامکی";
    case "recovery":
      return "کد بازیابی";
    case "pin":
      return "رمز عددی دستگاه";
    case "webauthn":
      return "ورود زیست‌سنجی";
  }
}
