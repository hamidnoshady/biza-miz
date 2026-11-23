/**
 * ESH-199 / #1384 follow-up — delivery of the global email proof.
 *
 * #1384 records a hashed, one-live-token proof in `platform_email_verifications`;
 * this module is the delivery half, kept separate so the identity service stays
 * free of SMTP. It uses the deployment-wide `platform_message_config` singleton,
 * the same transport `password-reset-request.ts` and scheduled exports already
 * use — never a tenant's mail server.
 *
 * The token is only ever placed in the link, never logged. When the deployment
 * has no SMTP transport or no canonical base URL, the caller gets
 * `unavailable` and can still finish onboarding; the address simply stays
 * unverified, which is exactly what the UI says.
 */
import { BRAND_NAME_FA } from "../brand";
import { platformBaseUrl } from "../deployment-role";
import { resolveMessageConfig } from "../messaging-billing";
import { SmtpMessageProvider } from "../messaging/providers/smtp";

export type IdentityEmailDeliveryOutcome = "sent" | "unavailable" | "failed";

export interface IdentityEmailDeliveryResult {
  outcome: IdentityEmailDeliveryOutcome;
  reason?: "no_base_url" | "no_transport" | "send_failed";
}

export function identityEmailVerificationUrl(
  baseUrl: string | null,
  token: string,
): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/verify/email/${encodeURIComponent(token)}`;
}

/** The body of the verification mail. Exported so the copy is reviewable. */
export function identityEmailVerificationMessage(verificationUrl: string): {
  subject: string;
  body: string;
} {
  return {
    subject: `تأیید ایمیل حساب ${BRAND_NAME_FA}`,
    body: [
      "برای تأیید این ایمیل در حساب بیزامیز، این پیوند را باز کنید:",
      verificationUrl,
      "",
      "این پیوند یک‌بار مصرف است و ۲۴ ساعت اعتبار دارد.",
      "اگر شما این درخواست را ثبت نکرده‌اید، این پیام را نادیده بگیرید؛",
      "ایمیل شما تا زمان تأیید برای اطلاع‌رسانی حساس یا بازیابی حساب استفاده نمی‌شود.",
    ].join("\n"),
  };
}

/**
 * Send the proof for an already-minted token.
 *
 * The caller mints the token through #1384 first, so the database records the
 * proof even on a deployment whose mail transport is temporarily unavailable;
 * the UI reports that honestly. No address or token is logged here.
 */
export async function sendIdentityEmailVerification(input: {
  to: string;
  token: string;
}): Promise<IdentityEmailDeliveryResult> {
  const baseUrl = platformBaseUrl();
  if (!baseUrl) return { outcome: "unavailable", reason: "no_base_url" };
  const verificationUrl = identityEmailVerificationUrl(baseUrl, input.token);
  if (!verificationUrl) return { outcome: "unavailable", reason: "no_base_url" };

  let config;
  try {
    config = await resolveMessageConfig();
  } catch {
    return { outcome: "failed", reason: "send_failed" };
  }
  if (!config.enabled || config.emailProvider !== "smtp" || !config.smtp) {
    return { outcome: "unavailable", reason: "no_transport" };
  }

  const provider = new SmtpMessageProvider({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.smtp.user,
    password: config.smtp.password ?? "",
    from: config.smtp.from,
  });

  try {
    const result = await provider.send({
      to: input.to,
      ...identityEmailVerificationMessage(verificationUrl),
    });
    return result.ok
      ? { outcome: "sent" }
      : { outcome: "failed", reason: "send_failed" };
  } catch {
    return { outcome: "failed", reason: "send_failed" };
  }
}
