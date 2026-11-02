/**
 * Phase 37 Wave 3 — the message-provider seam.
 *
 * A marketing message goes out through an adapter, and which provider carried it
 * is a detail, never an `if` scattered through the codebase. This file is that
 * seam: the `MessageProvider` contract, the shapes an outbound message and a
 * send result take, and the internal error catalogue with its Persian labels.
 *
 * `retryable` is the *adapter's* decision, never the outbox tick's guess: an
 * invalid number must never be retried, a dropped connection always should be.
 * The tick only ever asks the question the adapter already answered.
 */

import type { CampaignChannel } from "../campaign-channels";

export interface OutboundMessage {
  /** The destination: a phone number (SMS) or email address. */
  to: string;
  /** Email subject; empty for SMS. */
  subject?: string;
  body: string;
  /**
   * Files to attach. Email only — an SMS adapter ignores them.
   *
   * Added for the scheduled-export delivery in `data-transfer`: «فروش روزانه»
   * has to arrive as a spreadsheet, not as a link into an app the recipient may
   * not have a session for. Optional, so every existing caller (campaigns,
   * triggered messages) is unchanged.
   */
  attachments?: readonly OutboundAttachment[];
}

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export type SendResult =
  | {
      ok: true;
      providerMessageId: string;
      segments: number;
      /**
       * Issue #902: what the PROVIDER charged the platform for this send, in
       * Rial, when the provider reports it. This is wholesale cost evidence —
       * never the tenant's price, which stays the Billing-owned retail rate.
       * Optional so an adapter that cannot report cost is still a valid one.
       */
      providerCostRial?: number;
    }
  | { ok: false; retryable: boolean; code: string; message: string };

export type DeliveryOutcome = "delivered" | "pending" | "failed";

export interface DeliveryStatus {
  outcome: DeliveryOutcome;
  /** Persian-facing human reason for `failed`. */
  error?: string;
}

export interface MessageProvider {
  /** Stable key, e.g. "kavenegar" / "smtp". */
  readonly key: string;
  readonly channel: CampaignChannel;
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Optional delivery-status read for providers that report it. */
  fetchStatus?(providerMessageId: string): Promise<DeliveryStatus>;
}

/**
 * Internal provider error codes, with Persian labels (Phase 33's rule: an owner
 * never sees a raw provider code). These are the codes `SendResult.code`
 * carries and the UI maps to text.
 */
export const PROVIDER_ERROR_CODES = [
  "invalid_number",
  "blocked_word",
  "credit_exhausted",
  "rate_limit",
  "network",
  "timeout",
  "provider_rejected",
  "provider_config",
  "provider_unavailable",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const PROVIDER_ERROR_LABELS: Record<ProviderErrorCode, string> = {
  invalid_number: "شمارهٔ گیرنده نامعتبر است",
  blocked_word: "متن پیام شامل کلمهٔ مسدود است",
  credit_exhausted: "اعتبار پنل ارسال تمام شده است",
  rate_limit: "محدودیت نرخ ارسال فعال شد؛ کمی بعد دوباره تلاش می‌شود",
  network: "ارتباط با سرویس ارسال برقرار نشد",
  timeout: "سرویس ارسال پاسخ نداد",
  provider_rejected: "سرویس ارسال پیام را نپذیرفت",
  provider_config: "پیکربندی ارائه‌دهنده ناقص است",
  provider_unavailable: "ارائه‌دهندهٔ پیامک در دسترس نیست",
};

export function isProviderErrorCode(value: string): value is ProviderErrorCode {
  return (PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

/** Persian label for a code; unknown codes get a safe generic fallback. */
export function providerErrorLabel(code: string): string {
  return isProviderErrorCode(code) ? PROVIDER_ERROR_LABELS[code] : "ارسال ناموفق بود";
}
