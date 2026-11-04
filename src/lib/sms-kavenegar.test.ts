import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOperatorFault,
  KavenegarError,
  KavenegarProvider,
  kavenegarStatusMessage,
  OTP_SEND_TIMEOUT_MS,
  OTP_TIMEOUT_MESSAGE,
  redactKavenegarUrl,
} from "./sms-kavenegar";

describe("sms-kavenegar", () => {
  it("redacts API keys from Kavenegar URLs", () => {
    const raw = "https://api.kavenegar.com/v1/313233343536373839/verify/lookup.json?receptor=0912&token=1234&template=login";
    const redacted = redactKavenegarUrl(raw);
    expect(redacted).toBe("https://api.kavenegar.com/v1/REDACTED/verify/lookup.json?receptor=0912&token=REDACTED&template=login");
    expect(redacted).not.toContain("313233343536373839");
  });

  it("also redacts the OTP itself — a rejected/failed request otherwise puts the live code straight into server logs", () => {
    const raw = "https://api.kavenegar.com/v1/apikey/verify/lookup.json?receptor=0912&token=482913&template=login";
    const redacted = redactKavenegarUrl(raw);
    expect(redacted).not.toContain("482913");
  });
});

describe("Kavenegar status codes", () => {
  it("maps the codes an operator will actually hit to Persian", () => {
    // 411 invalid receptor, 418 out of credit, 424 template missing — the three
    // that account for most real failures.
    expect(kavenegarStatusMessage(411)).toContain("گیرنده");
    expect(kavenegarStatusMessage(418)).toContain("اعتبار");
    expect(kavenegarStatusMessage(424)).toContain("الگو");
  });

  it("never leaves an unknown code as raw carrier English", () => {
    const message = kavenegarStatusMessage(999);
    expect(message).toMatch(/[\u0600-\u06FF]/); // Persian text, not the carrier's English
    expect(message).toMatch(/999/); // the code itself is still diagnosable from a screenshot
    expect(message).not.toMatch(/[a-z]{4,}/); // no English words
  });

  it("distinguishes an operator's problem from the user's", () => {
    // Told "invalid receptor" a user retypes their number and it works. Told the
    // same when the real cause is an empty credit balance, they retype it
    // twenty times and phone support — so 418 is operator-fault and 411 is not.
    expect(isOperatorFault(411)).toBe(false);
    expect(isOperatorFault(418)).toBe(true);
    expect(isOperatorFault(403)).toBe(true);
    expect(isOperatorFault(424)).toBe(true);
  });

  it("carries the status on the error, and never the API key", () => {
    const err = new KavenegarError(418);
    expect(err.status).toBe(418);
    expect(err.operatorFault).toBe(true);
    expect(JSON.stringify({ message: err.message, name: err.name })).not.toContain("api.kavenegar.com");
  });
});

/**
 * Issue #902 §9 item 7 (DoD #11) — a stalled carrier must not hold a login open.
 *
 * Every other supplier call in this codebase aborts on a timeout. This one — the
 * transport that sends the codes people log in with — did not, so a supplier that
 * accepted the connection and went quiet left the request hanging and the person
 * waiting looking at a spinner. The stale code then stayed live for its full five
 * minutes, because nothing had failed and so nothing consumed it.
 */
describe("the login-code transport gives up", () => {
  const apiKey = "31323334353637383939616263646566";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes an abort signal on every dispatch, with a bounded delay", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return { ok: true, status: 200, json: async () => ({ return: { status: 200 } }) };
    });

    await new KavenegarProvider(apiKey, "verify").sendOtp("+989120000001", "123456");

    expect(signals).toHaveLength(1);
    // A signal, not a hand-rolled race: `AbortSignal.timeout` is what cancels the
    // socket, and it reports `TimeoutError` rather than a generic abort.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(OTP_SEND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reports a timeout in Persian, and says nothing that could log a live code", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", async () => {
      throw timeout;
    });

    const err = await new KavenegarProvider(apiKey, "verify", 5)
      .sendOtp("+989120000001", "482913")
      .then(
        () => null,
        (thrown: unknown) => thrown as KavenegarError,
      );

    expect(err).toBeInstanceOf(KavenegarError);
    expect(err!.message).toBe(OTP_TIMEOUT_MESSAGE);
    // The operator needs to know it timed out; they do not need the code, the
    // number or the key in the same line — the code is still valid for minutes.
    expect(err!.message).not.toContain("482913");
    expect(err!.message).not.toContain("api.kavenegar.com");
    expect(err!.message).not.toContain(apiKey);
    // A timeout is not a user fault: nothing the person typed caused it.
    expect(err!.operatorFault).toBe(false);
  });

  it("keeps a connection failure distinct from a stall", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    const err = (await new KavenegarProvider(apiKey, "verify")
      .sendOtp("+989120000001", "123456")
      .catch((thrown: unknown) => thrown)) as KavenegarError;

    // Different sentence, because the fix differs: this one is "we could not
    // reach them", the other is "they took the request and went quiet".
    expect(err.message).not.toBe(OTP_TIMEOUT_MESSAGE);
    expect(err.message).toContain("برقرار نشد");
  });

  it("still sends when the carrier answers in time", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ return: { status: 200 } }) };
    });
    await new KavenegarProvider(apiKey, "verify").sendOtp("+989120000001", "123456");
    expect(called).toBe(true);
  });
});
