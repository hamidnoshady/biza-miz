export interface SmsProvider {
  sendOtp(phoneE164: string, otp: string): Promise<void>;
}

/**
 * Issue #902 DoD #9 — "No OTP logged in production plaintext via noop fallback."
 *
 * A one-time code is only a secret until it is written down. The offline
 * fallback has always printed the code so that a developer without an SMS
 * account can finish a login by reading the terminal, and that is exactly the
 * convenience that turns a production deployment with no configured key into a
 * machine that writes every live login code into a log file, an aggregator and
 * whoever can read them — while the person waiting for the SMS gets nothing.
 *
 * The fallback therefore reads `NODE_ENV` and refuses rather than pretending:
 *
 *   * `development` / `test` — logs the code, as before. Nothing is deployed
 *     with those values and the terminal is the developer's own.
 *   * anything else, **including an unset `NODE_ENV`** — throws. Fail closed:
 *     a deployment that forgot to declare its environment is not evidence that
 *     it is safe to print login codes, and a code nobody can read is not worth
 *     logging.
 *
 * Every caller already handles a failed dispatch honestly — the challenge or
 * reset link is consumed and the person is told the message could not be sent
 * (`sms_dispatch_failed`) — so the refusal reaches the screen instead of a
 * silent "sent" that never arrives.
 */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super("sms_not_configured");
    this.name = "SmsNotConfiguredError";
  }
}

/** Prefix on the development-only fallback line, kept as a constant so a test can assert its absence. */
export const SMS_NOOP_LOG_PREFIX = "[SMS NOOP]";

/** The two environments where printing a live code is a developer's own terminal. */
function isDevelopmentLike(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
}

export class NoopProvider implements SmsProvider {
  /**
   * The environment is injectable for the same reason the decision is worth
   * testing: `NODE_ENV` is read at call time, not import time, and a test that
   * mutated the process-global would leak into every other file in the run.
   */
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async sendOtp(phoneE164: string, otp: string): Promise<void> {
    if (isDevelopmentLike(this.environment)) {
      console.log(`${SMS_NOOP_LOG_PREFIX} To: ${phoneE164} OTP: ${otp}`);
      return;
    }

    // Deliberately says neither the number nor the code: this line is what an
    // operator reads at 2am, and it has to be enough to act on without being
    // enough to log in with.
    console.error(
      "SMS is not configured and this deployment is not a development environment: " +
        "refusing to log a one-time code in plaintext. Configure the SMS connection in the " +
        "platform console (or the KAVENEGAR_API_KEY environment variable) to deliver codes.",
    );
    throw new SmsNotConfiguredError();
  }
}
