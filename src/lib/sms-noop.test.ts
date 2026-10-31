/**
 * Issue #902 DoD #9, second half — "No OTP logged in production plaintext via
 * noop fallback."
 *
 * The sibling boundary test (`kavenegar/lookup-trigger-boundaries.test.ts`)
 * proves the auth path never borrows a business's child account, so a login
 * keeps working when Growth is off or a wallet is empty. This one covers the
 * other way an OTP leaks: the fallback that exists for developers printing a
 * live code into a production log.
 *
 * The environment is injected rather than mutated, because `NODE_ENV` is a
 * process global and these assertions are about a *branch*, not about the run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopProvider, SMS_NOOP_LOG_PREFIX, SmsNotConfiguredError } from "./sms";

const CODE = "483920";
const PHONE = "+4915112345678";

function capture() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    written: () => [...log.mock.calls, ...error.mock.calls].map((args) => args.join(" ")).join("\n"),
    log,
    error,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the OTP fallback", () => {
  it.each(["development", "test"])("prints the code in %s, which is a developer's terminal", async (nodeEnv) => {
    const out = capture();
    await new NoopProvider({ NODE_ENV: nodeEnv }).sendOtp(PHONE, CODE);

    expect(out.log).toHaveBeenCalledWith(`${SMS_NOOP_LOG_PREFIX} To: ${PHONE} OTP: ${CODE}`);
    expect(out.written()).toContain(CODE);
  });

  it.each(["production", "staging", undefined])(
    "refuses in %s instead of printing a live code",
    async (nodeEnv) => {
      const out = capture();
      const provider = new NoopProvider(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv });

      await expect(provider.sendOtp(PHONE, CODE)).rejects.toBeInstanceOf(SmsNotConfiguredError);

      // The whole point: not in the log, in any shape.
      expect(out.written()).not.toContain(CODE);
      expect(out.written()).not.toContain(SMS_NOOP_LOG_PREFIX);
      expect(out.written()).not.toContain(PHONE);
      // ...but the operator is told something true and actionable.
      expect(out.error).toHaveBeenCalled();
      expect(out.written()).toMatch(/not configured/i);
    },
  );

  it("carries no secret in the error it throws", async () => {
    capture();
    const error: unknown = await new NoopProvider({ NODE_ENV: "production" })
      .sendOtp(PHONE, CODE)
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(SmsNotConfiguredError);
    const thrown = error as Error;
    expect(thrown.message).toBe("sms_not_configured");
    expect(JSON.stringify({ message: thrown.message, stack: thrown.stack })).not.toContain(CODE);
  });

  it("is the fallback the resolver returns, and is what a dispatch failure reports", async () => {
    // The guard only matters if it is on the path: `getSmsProvider()` returns
    // this class when no key exists anywhere, and the send routes turn its
    // throw into `sms_dispatch_failed` rather than a "sent" screen.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const config = readFileSync(`${root}src/lib/sms-config.ts`, "utf8");

    expect(config).toMatch(/return new NoopProvider\(\)/);
    expect(config).not.toMatch(/new NoopProvider\(\{\s*NODE_ENV:\s*"production"/);
  });
});
