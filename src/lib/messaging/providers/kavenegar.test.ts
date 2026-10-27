import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKavenegarSendRequest,
  kavenegarApiStatusToResult,
  parseKavenegarResponse,
} from "./kavenegar";
import { providerErrorLabel } from "../provider";
import { KavenegarMessageProvider } from "./kavenegar-client";

describe("buildKavenegarSendRequest", () => {
  it("points at the account's send endpoint with receptor/message/sender", () => {
    const req = buildKavenegarSendRequest({
      apiKey: "SECRETKEY",
      sender: "10004346",
      receptor: "989121111111",
      message: "سلام",
    });
    expect(req.url).toContain("/v1/SECRETKEY/sms/send.json");
    expect(req.params.receptor).toBe("989121111111");
    expect(req.params.message).toBe("سلام");
    expect(req.params.sender).toBe("10004346");
  });

  it("omits sender when there is no line number configured", () => {
    const req = buildKavenegarSendRequest({
      apiKey: "K",
      sender: "",
      receptor: "1",
      message: "x",
    });
    expect(req.params.sender).toBeUndefined();
  });
});

describe("parseKavenegarResponse + classification", () => {
  const okBody = JSON.stringify({
    return: {
      status: 200,
      message: "ok",
      entries: [{ messageid: "12345", receptor: "98912", status: 1, cost: "900" }],
    },
  });

  it("marks an accepted send as ok with the provider message id", () => {
    const parsed = parseKavenegarResponse(okBody)!;
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBe("12345");
  });

  it("never retries a blocked word (406)", () => {
    const parsed = parseKavenegarResponse(
      JSON.stringify({ return: { status: 406, message: "blocked", entries: [] } }),
    )!;
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.code).toBe("blocked_word");
    expect(providerErrorLabel(result.code)).toBe("متن پیام شامل کلمهٔ مسدود است");
  });

  it("never retries an invalid number (412)", () => {
    const parsed = parseKavenegarResponse(
      JSON.stringify({ return: { status: 412, message: "bad num", entries: [] } }),
    )!;
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.retryable).toBe(false);
    expect(result.code).toBe("invalid_number");
  });

  it("treats exhausted panel credit (402) as permanent", () => {
    const parsed = parseKavenegarResponse(
      JSON.stringify({ return: { status: 402, message: "low", entries: [] } }),
    )!;
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.code).toBe("credit_exhausted");
  });

  it("retries an unknown/transient non-200 status", () => {
    const parsed = parseKavenegarResponse(
      JSON.stringify({ return: { status: 599, message: "wtf", entries: [] } }),
    )!;
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("renders a Persian label for any code (no raw provider code to the owner)", () => {
    expect(providerErrorLabel("invalid_number")).toContain("نامعتبر");
    expect(providerErrorLabel("bogus_unknown")).not.toBe("");
  });
});

/**
 * Issue #902 — the spike found two defects in this parser, both fixed here:
 * the documented send reply puts `entries` beside `return` (not inside it), and
 * the per-message `cost` was discarded. A recorded fixture is below.
 */
describe("documented send envelope (issue #902)", () => {
  const documented = JSON.stringify({
    return: { status: 200, message: "تایید شد" },
    entries: [
      {
        messageid: 8792343,
        message: "خدمات پیام کوتاه کاوه نگار",
        status: 1,
        statustext: "در صف ارسال",
        sender: "10004346",
        receptor: "09*********",
        date: 1356619709,
        cost: 120,
      },
    ],
  });

  it("reads the TOP-LEVEL entries array and keeps the message id", () => {
    const parsed = parseKavenegarResponse(documented)!;
    expect(parsed.entries).toHaveLength(1);
    const result = kavenegarApiStatusToResult(parsed);
    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBe("8792343");
  });

  it("preserves the provider's wholesale cost as an integer Rial amount", () => {
    const parsed = parseKavenegarResponse(documented)!;
    expect(parsed.entries[0]?.costRial).toBe(120);
  });

  it("reports the provider cost on the adapter's SendResult", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(documented, { status: 200 })),
    );
    const provider = new KavenegarMessageProvider("KEY", "10004346");
    const result = await provider.send({ to: "09121111111", body: "سلام" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerMessageId).toBe("8792343");
      expect(result.providerCostRial).toBe(120);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
