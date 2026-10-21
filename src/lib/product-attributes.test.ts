import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_NAME_MAX_LENGTH,
  ATTRIBUTE_OPTION_MAX_LENGTH,
  ATTRIBUTE_OPTIONS_MAX_COUNT,
  ATTRIBUTE_REQUEST_MAX_BYTES,
  PRODUCT_CREATE_REQUEST_MAX_BYTES,
  attributeComparisonKey,
  normalizeAttributeText,
  parseAttributeDefinitionInput,
  readBoundedJson,
} from "./product-attributes";

describe("product attribute normalization", () => {
  it("canonicalizes whitespace and Arabic/Persian letter variants", () => {
    expect(normalizeAttributeText("  رنگ\tكِي  ")).toBe("رنگ کِی");
    expect(attributeComparisonKey("كیف ")).toBe(attributeComparisonKey("کیف"));
    expect(attributeComparisonKey(" نیم‌سایز ")).toBe(attributeComparisonKey("نیم سایز"));
  });
});

describe("parseAttributeDefinitionInput", () => {
  it("accepts create defaults and normalizes options", () => {
    expect(parseAttributeDefinitionInput({ name: "  رنگ  ", options: [" قرمز ", "مشکی"] }, "create")).toEqual({
      ok: true,
      data: { name: "رنگ", options: ["قرمز", "مشکی"], isActive: true },
      issues: [],
    });
  });

  it.each([null, [], "value", 42])("rejects non-object request bodies: %s", (body) => {
    expect(parseAttributeDefinitionInput(body, "create")).toMatchObject({ ok: false, issues: [{ code: "invalid_object" }] });
  });

  it("rejects malformed fields, unknown keys and empty patches without throwing", () => {
    expect(parseAttributeDefinitionInput({ name: 123, options: "red", isActive: "yes" }, "create")).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "name", code: "invalid_name" }),
        expect.objectContaining({ field: "options", code: "invalid_options" }),
        expect.objectContaining({ field: "isActive", code: "invalid_status" }),
      ]),
    });
    expect(parseAttributeDefinitionInput({ name: "رنگ", admin: true }, "create")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "unknown_field", field: "admin" })],
    });
    expect(parseAttributeDefinitionInput({ version: 1 }, "patch")).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "empty_patch" })]),
    });
  });

  it("requires a valid optimistic-concurrency version on every patch", () => {
    expect(parseAttributeDefinitionInput({ name: "رنگ" }, "patch")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "version", code: "version_required" })],
    });
    expect(parseAttributeDefinitionInput({ name: "رنگ", version: 0 }, "patch")).toMatchObject({ ok: false });
    expect(parseAttributeDefinitionInput({ isActive: false, version: 2 }, "patch")).toEqual({
      ok: true,
      data: { isActive: false, version: 2 },
      issues: [],
    });
  });

  it("rejects blank, overlong, excessive and visually duplicated options", () => {
    const tooMany = Array.from({ length: ATTRIBUTE_OPTIONS_MAX_COUNT + 1 }, (_, index) => `v${index}`);
    expect(parseAttributeDefinitionInput({ name: "رنگ", options: tooMany }, "create")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "options", code: "too_many_options" })],
    });
    expect(parseAttributeDefinitionInput({ name: "رنگ", options: ["  "] }, "create")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "empty_option" })],
    });
    expect(parseAttributeDefinitionInput({ name: "رنگ", options: ["كي", "کی"] }, "create")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "duplicate_option" })],
    });
    expect(parseAttributeDefinitionInput({ name: "x".repeat(ATTRIBUTE_NAME_MAX_LENGTH + 1) }, "create")).toMatchObject({ ok: false });
    expect(parseAttributeDefinitionInput({ name: "رنگ", options: ["x".repeat(ATTRIBUTE_OPTION_MAX_LENGTH + 1)] }, "create")).toMatchObject({ ok: false });
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const supplementary = "😀".repeat(Math.ceil(ATTRIBUTE_NAME_MAX_LENGTH / 2));
    expect(parseAttributeDefinitionInput({ name: supplementary }, "create").ok).toBe(true);
  });
});

describe("readBoundedJson", () => {
  it("parses a small JSON request and rejects malformed JSON", async () => {
    expect(await readBoundedJson(new Request("http://example.test", { method: "POST", body: '{"name":"رنگ"}' }))).toEqual({
      ok: true,
      value: { name: "رنگ" },
    });
    expect(await readBoundedJson(new Request("http://example.test", { method: "POST", body: "{" }))).toEqual({
      ok: false,
      error: "bad_request",
    });
  });

  it("allows the larger bounded envelope used by the product-create API", async () => {
    const body = JSON.stringify({ value: "x".repeat(ATTRIBUTE_REQUEST_MAX_BYTES + 1) });
    expect(await readBoundedJson(
      new Request("http://example.test", { method: "POST", body }),
      PRODUCT_CREATE_REQUEST_MAX_BYTES,
    )).toMatchObject({ ok: true });
  });

  it("rejects oversized requests both from their header and while streaming", async () => {
    const large = "x".repeat(ATTRIBUTE_REQUEST_MAX_BYTES + 1);
    expect(
      await readBoundedJson(
        new Request("http://example.test", { method: "POST", headers: { "content-length": String(large.length) }, body: large }),
      ),
    ).toEqual({ ok: false, error: "payload_too_large" });

    const streamed = new Request("http://example.test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(large));
          controller.close();
        },
      }),
      // @ts-expect-error Node requires duplex for a streaming request body.
      duplex: "half",
    });
    expect(await readBoundedJson(streamed)).toEqual({ ok: false, error: "payload_too_large" });
  });
});
