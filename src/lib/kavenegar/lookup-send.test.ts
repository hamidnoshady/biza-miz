import { describe, expect, it } from "vitest";
import { buildLookupSendRequest, mapLookupEntry, normalizeReceptor } from "./client";

describe("normalizeReceptor — one subscriber, however it was stored", () => {
  it("accepts what a Persian keyboard and a CRM both produce", () => {
    expect(normalizeReceptor("09121234567")).toBe("09121234567");
    expect(normalizeReceptor("۰۹۱۲۱۲۳۴۵۶۷")).toBe("09121234567");
    expect(normalizeReceptor("+98 912 123 4567")).toBe("09121234567");
    expect(normalizeReceptor("00989121234567")).toBe("09121234567");
    expect(normalizeReceptor("989121234567")).toBe("09121234567");
    expect(normalizeReceptor("0912-123-4567")).toBe("09121234567");
  });

  it("refuses anything that is not an Iranian mobile", () => {
    // A provider call with a bad receptor is a billed failure (411), so the
    // refusal has to happen here.
    expect(normalizeReceptor("02112345678")).toBeNull();
    expect(normalizeReceptor("0912123456")).toBeNull();
    expect(normalizeReceptor("091212345678")).toBeNull();
    expect(normalizeReceptor("")).toBeNull();
    expect(normalizeReceptor("not a number")).toBeNull();
  });
});

describe("buildLookupSendRequest", () => {
  it("posts to the CHILD's key in the path, never the master's", () => {
    const request = buildLookupSendRequest({
      apiKey: "CHILDKEY",
      template: "bm0d5f4c7e",
      receptor: "09121234567",
      tokens: ["سارا"],
    });
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.kavenegar.com/v1/CHILDKEY/verify/lookup.json");
    expect(request.params).toMatchObject({
      receptor: "09121234567",
      template: "bm0d5f4c7e",
      token: "سارا",
    });
  });

  it("spells the slots the way the provider's substitution pass reads them", () => {
    const request = buildLookupSendRequest({
      apiKey: "CHILDKEY",
      template: "bm0d5f4c7e",
      receptor: "09121234567",
      tokens: ["سارا", "فروشگاه نمونه", "۲۵۰٬۰۰۰"],
    });
    expect(request.params.token).toBe("سارا");
    expect(request.params.token2).toBe("فروشگاه نمونه");
    expect(request.params.token3).toBe("۲۵۰٬۰۰۰");
  });

  it("carries the sender line only when the policy fixes one", () => {
    const without = buildLookupSendRequest({
      apiKey: "CHILDKEY",
      template: "t",
      receptor: "09121234567",
      tokens: ["a"],
    });
    expect(without.params.sender).toBeUndefined();
    const withLine = buildLookupSendRequest({
      apiKey: "CHILDKEY",
      template: "t",
      receptor: "09121234567",
      tokens: ["a"],
      sender: "10004346",
    });
    expect(withLine.params.sender).toBe("10004346");
  });
});

describe("mapLookupEntry", () => {
  it("keeps the message id and the provider's rial cost", () => {
    expect(mapLookupEntry({ messageid: 1234567, status: 5, cost: "150" })).toEqual({
      messageId: "1234567",
      costRial: 150,
      status: 5,
    });
  });

  it("reports a missing cost as null rather than zero", () => {
    // The margin report prefers an honest gap to a fabricated zero.
    expect(mapLookupEntry({ messageid: 1, status: 1 }).costRial).toBeNull();
    expect(mapLookupEntry({ messageid: 1, status: 1, cost: "0" }).costRial).toBeNull();
    expect(mapLookupEntry({ messageid: 1, status: 1, cost: "abc" }).costRial).toBeNull();
  });
});
