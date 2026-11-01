export interface SmsProvider {
  /** Which transport this is, so callers can say honestly whether a message went out. */
  readonly name: "noop" | "kavenegar";
  sendOtp(phoneE164: string, otp: string): Promise<void>;
  /**
   * Plain-text delivery, when the deployment has a sender line for it.
   *
   * Optional on purpose: the OTP door works with a lookup template alone, while
   * a contract-signing invitation carries a LINK, which a template cannot. A
   * provider without a sender line simply does not implement this, and the
   * caller reports «پیامک تنظیم نشده» instead of pretending it was sent
   * (issue #908: no fake confirmations).
   */
  sendText?(phoneE164: string, message: string): Promise<void>;
}

export class NoopProvider implements SmsProvider {
  readonly name = "noop" as const;

  async sendOtp(phoneE164: string, otp: string): Promise<void> {
    console.log(`[SMS NOOP] To: ${phoneE164} OTP: ${otp}`);
  }

  async sendText(phoneE164: string, message: string): Promise<void> {
    console.log(`[SMS NOOP] To: ${phoneE164} TEXT: ${message}`);
  }
}
