/**
 * Issue #885 L10 — forgotten-password *initiation*.
 *
 * Redemption already existed: an admin could mint a link from the team page
 * and `consumePasswordResetToken` would accept it. What was missing is the
 * half a locked-out manager actually needs — a way to ask for one without
 * first finding someone who can log in.
 *
 * Two constraints shape this file, and they pull against each other:
 *
 *   1. It must not enumerate. The endpoint is pre-session and takes an email
 *      address, so it is exactly the oracle an attacker wants: "does this
 *      address have an account here?" Every path therefore answers the same
 *      200 with the same body. The distinctions below exist for logs and
 *      tests, never for the caller.
 *
 *   2. It must not hand out links to whoever asks. So it is rate-limited per
 *      address, and the link goes only to the address on file.
 *
 * The transport is the platform's own: `resolveMessageConfig()` reads the
 * `platform_message_config` singleton (`WHERE id = true`, under
 * `withoutTenantScope("platform")`), so it is a deployment-wide setting and
 * not something a tenant configures. `data-transfer/schedule-service.ts`
 * already sends non-campaign mail through the same `SmtpMessageProvider`, so
 * a security email here is not bending a marketing pipe to a new purpose.
 */

import { resolveMessageConfig } from "./messaging-billing";
import { SmtpMessageProvider } from "./messaging/providers/smtp";
import { platformBaseUrl } from "./deployment-role";
import { issuePasswordResetToken } from "./password-reset";
import { query, withoutTenantScope } from "./db";

/**
 * Sliding-window caps on reset requests, per address.
 *
 * Deliberately tighter than the phone-OTP budget: a human forgets a password
 * a couple of times a day at most, and the cost of being wrong is an email
 * rather than an SMS.
 */
export const PASSWORD_RESET_REQUEST_LIMITS: ReadonlyArray<{ max: number; windowMs: number }> = [
  { max: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour
  { max: 8, windowMs: 24 * 60 * 60 * 1000 }, // 8 per day
];

export type PasswordResetRequestOutcome =
  /** A link was minted and dispatched to the address on file. */
  | { outcome: "sent"; subjectId: string }
  /** No platform_user with that address. Indistinguishable from `sent`. */
  | { outcome: "unknown_email" }
  /** The account exists but is deactivated. Also indistinguishable. */
  | { outcome: "inactive" }
  /** Too many recent requests for this address. Also indistinguishable. */
  | { outcome: "rate_limited"; retryAfterMs: number }
  /** No SMTP configured, or no canonical base URL to build a link from. */
  | { outcome: "not_configured"; reason: "no_transport" | "no_base_url" };

export interface PasswordResetBudgetDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Decide whether another request fits the budget.
 *
 * Pure and order-independent so it can be tested without a database, and so
 * it cannot be skewed by the order Postgres happens to return rows in.
 * Stamps that fail to parse, or that are newer than `now` (clock skew), are
 * ignored rather than counted: a corrupt row must not lock a user out.
 */
export function passwordResetBudgetDecision(
  createdAt: ReadonlyArray<Date | string | null | undefined>,
  now: Date = new Date(),
  limits: ReadonlyArray<{ max: number; windowMs: number }> = PASSWORD_RESET_REQUEST_LIMITS,
): PasswordResetBudgetDecision {
  const stamps = createdAt
    .map((value) => (value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""))))
    .filter((ms) => Number.isFinite(ms) && ms <= now.getTime());

  let retryAfterMs = 0;
  for (const { max, windowMs } of limits) {
    const windowStart = now.getTime() - windowMs;
    const inWindow = stamps.filter((ms) => ms > windowStart);
    if (inWindow.length >= max) {
      // Wait until the oldest send in this window ages out of it.
      const oldest = Math.min(...inWindow);
      retryAfterMs = Math.max(retryAfterMs, oldest + windowMs - now.getTime());
    }
  }

  // Never hand back a negative or fractional wait.
  return { allowed: retryAfterMs === 0, retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) };
}

/** The body of a reset email. Exported so the copy can be reviewed in tests. */
export function passwordResetEmail(resetUrl: string): { subject: string; body: string } {
  return {
    subject: "بازنشانی رمز عبور",
    body: [
      "درخواستی برای بازنشانی رمز عبور این حساب ثبت شد.",
      "",
      "برای انتخاب رمز تازه، این پیوند را باز کنید:",
      resetUrl,
      "",
      "پیوند یک‌بار مصرف است و ۲۴ ساعت اعتبار دارد.",
      "اگر شما این درخواست را ثبت نکرده‌اید، این پیام را نادیده بگیرید؛",
      "رمز کنونی شما تغییر نکرده است.",
    ].join("\n"),
  };
}

/**
 * Request a password reset for a platform user.
 *
 * The caller must treat every branch as equivalent. Nothing here throws for
 * "no such user": that is the whole point.
 */
export async function requestPlatformUserPasswordReset(
  email: string,
): Promise<PasswordResetRequestOutcome> {
  // Already canonical when it comes from `loginEmailOrNull`, but this is a
  // library boundary and the column is citext — normalise regardless so the
  // rate-limit window and the lookup agree on one spelling.
  const normalized = email.trim().toLowerCase();

  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM platform_users WHERE email = $1`,
      [normalized],
    );
    const user = rows[0];

    if (!user) return { outcome: "unknown_email" } as const;
    if (!user.is_active) return { outcome: "inactive" } as const;

    const { rows: recent } = await query<{ created_at: Date | string }>(
      `SELECT created_at FROM auth_password_resets
        WHERE subject_realm = 'platform_user'
          AND subject_id = $1
          AND created_at > now() - interval '24 hours'`,
      [user.id],
    );
    const decision = passwordResetBudgetDecision(recent.map((r) => r.created_at));
    if (!decision.allowed) {
      return { outcome: "rate_limited", retryAfterMs: decision.retryAfterMs } as const;
    }

    // Resolve delivery *before* minting the token. Issuing a link that can
    // never be delivered would revoke the user's existing pending token (see
    // `issuePasswordResetToken`) and leave them with nothing — a way for an
    // unconfigured deployment to make recovery strictly worse.
    const base = platformBaseUrl();
    if (!base) {
      return { outcome: "not_configured", reason: "no_base_url" } as const;
    }
    const config = await resolveMessageConfig();
    if (!config.enabled || config.emailProvider !== "smtp" || !config.smtp) {
      return { outcome: "not_configured", reason: "no_transport" } as const;
    }

    const { token } = await issuePasswordResetToken({
      subjectRealm: "platform_user",
      subjectId: user.id,
      email: normalized,
    });

    const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    const provider = new SmtpMessageProvider({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      password: config.smtp.password ?? "",
      from: config.smtp.from,
    });

    // Sent without awaiting, on purpose.
    //
    // Waiting for SMTP here would make the response time a function of
    // whether the address exists — a known account pays a network round trip,
    // an unknown one returns instantly, and that timing difference is an
    // enumeration oracle no identical response body can hide. Errors are
    // logged, not surfaced: the caller already got the same answer either way.
    void provider.send({ to: normalized, ...passwordResetEmail(resetUrl) }).catch((error) => {
      console.error("password reset email failed", {
        email: normalized,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return { outcome: "sent", subjectId: user.id } as const;
  });
}
