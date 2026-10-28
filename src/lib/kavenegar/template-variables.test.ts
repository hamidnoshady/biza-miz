import { describe, expect, it } from "vitest";
import {
  MAX_TOKEN_LENGTH,
  SAMPLE_TEMPLATE_VALUES,
  TEMPLATE_VARIABLE_RENDERERS,
  isTemplateVariable,
  renderTemplateSample,
  renderTemplateTokens,
  tokenSlots,
  validateTemplateVariables,
  type TemplateVariable,
} from "./template-variables";

const BODY = "%token عزیز، سفارش شما در %token2 آمادهٔ تحویل است.";
const VARIABLES: TemplateVariable[] = ["customer_name", "store_name"];

describe("tokenSlots — what a body is allowed to contain", () => {
  it("reads the slots a body uses, in order", () => {
    expect(tokenSlots(BODY)).toEqual({ ok: true, slots: [0, 1] });
    expect(tokenSlots("%token")).toEqual({ ok: true, slots: [0] });
    expect(tokenSlots("%token2 و %token3 و %token")).toEqual({ ok: true, slots: [0, 1, 2] });
  });

  it("refuses a body with no token at all", () => {
    // The provider rejects it, and a template that cannot be personalised is a
    // broadcast wearing a lookup's clothes.
    expect(tokenSlots("سفارش شما آماده است.")).toEqual({ ok: false, code: "body_missing_token" });
  });

  it("refuses slots the library cannot map", () => {
    expect(tokenSlots("%token4").ok).toBe(false);
    expect(tokenSlots("%token10")).toEqual({ ok: false, code: "token_slot_unsupported" });
    expect(tokenSlots("%name")).toEqual({ ok: false, code: "token_slot_unsupported" });
    expect(tokenSlots("%token1")).toEqual({ ok: false, code: "token_slot_unsupported" });
  });

  it("refuses a gap, because position is the mapping", () => {
    // `%token2` with no `%token`: the provider would substitute whatever passed
    // for slot 2 into a sentence that expects the customer's name first.
    expect(tokenSlots("%token2 عزیز")).toEqual({ ok: false, code: "token_slot_gap" });
    expect(tokenSlots("%token و %token3")).toEqual({ ok: false, code: "token_slot_gap" });
  });

  it("refuses a repeated slot", () => {
    expect(tokenSlots("%token و %token")).toEqual({ ok: false, code: "token_slot_unsupported" });
  });
});

describe("validateTemplateVariables — the declared mapping", () => {
  it("accepts a body and its variables in the same order", () => {
    expect(validateTemplateVariables({ body: BODY, variables: VARIABLES })).toEqual({
      ok: true,
      variables: VARIABLES,
    });
  });

  it("refuses a count that does not match the body", () => {
    expect(validateTemplateVariables({ body: BODY, variables: ["customer_name"] })).toEqual({
      ok: false,
      code: "variables_mismatch",
    });
  });

  it("refuses an invented variable", () => {
    // The registry is the whole vocabulary; a template cannot name an
    // arbitrary field and hope a caller fills it.
    expect(
      validateTemplateVariables({ body: BODY, variables: ["customer_name", "invoice_url"] }),
    ).toEqual({ ok: false, code: "variable_not_allowed", variable: "invoice_url" });
  });
});

describe("renderTemplateTokens — domain data in, provider tokens out", () => {
  it("renders each slot and a preview of the message", () => {
    const result = renderTemplateTokens({
      body: BODY,
      variables: VARIABLES,
      values: { customer_name: "سارا محمدی", store_name: "فروشگاه نمونه" },
    });
    expect(result).toEqual({
      ok: true,
      tokens: ["سارا محمدی", "فروشگاه نمونه"],
      preview: "سارا محمدی عزیز، سفارش شما در فروشگاه نمونه آمادهٔ تحویل است.",
    });
  });

  it("refuses a missing value instead of sending an empty sentence", () => {
    expect(
      renderTemplateTokens({ body: BODY, variables: VARIABLES, values: { customer_name: "سارا" } }),
    ).toEqual({ ok: false, code: "variable_missing", variable: "store_name" });
  });

  it("refuses an invalid value rather than truncating it quietly", () => {
    expect(
      renderTemplateTokens({
        body: BODY,
        variables: VARIABLES,
        values: { customer_name: "  ", store_name: "فروشگاه" },
      }),
    ).toEqual({ ok: false, code: "variable_invalid", variable: "customer_name" });
    expect(
      renderTemplateTokens({
        body: BODY,
        variables: VARIABLES,
        values: { customer_name: "سارا", store_name: 42 as unknown as string },
      }).ok,
    ).toBe(true); // a number is still a name-shaped string once coerced
    expect(
      renderTemplateTokens({
        body: BODY,
        variables: VARIABLES,
        values: { customer_name: "سارا", store_name: { evil: true } as unknown as string },
      }),
    ).toEqual({ ok: false, code: "variable_invalid", variable: "store_name" });
  });

  it("strips control characters and stray percent signs from a name", () => {
    // A `%` in a value would look like another token to the provider's own
    // substitution pass, and a newline would break the segment.
    const result = renderTemplateTokens({
      body: BODY,
      variables: VARIABLES,
      values: { customer_name: "سارا\n%token", store_name: "فروشگاه" },
    });
    expect(result.ok && result.tokens[0]).toBe("سارا token");
  });

  it("caps a name at one token's worth of characters", () => {
    const long = "ا".repeat(60);
    const result = renderTemplateTokens({
      body: BODY,
      variables: VARIABLES,
      values: { customer_name: long, store_name: "فروشگاه" },
    });
    expect(result.ok && result.tokens[0].length).toBe(MAX_TOKEN_LENGTH);
  });
});

describe("each variable renderer", () => {
  it("keeps a code as ASCII digits, because a human types it back", () => {
    expect(TEMPLATE_VARIABLE_RENDERERS.code("۴۸۲۹۱۳")).toEqual({ ok: true, value: "482913" });
    expect(TEMPLATE_VARIABLE_RENDERERS.code(482913)).toEqual({ ok: true, value: "482913" });
    expect(TEMPLATE_VARIABLE_RENDERERS.code("12ab")).toEqual({ ok: false });
    expect(TEMPLATE_VARIABLE_RENDERERS.code("123")).toEqual({ ok: false });
  });

  it("formats an amount in Persian grouped digits, in rial", () => {
    expect(TEMPLATE_VARIABLE_RENDERERS.amount(250_000)).toEqual({ ok: true, value: "۲۵۰٬۰۰۰" });
    expect(TEMPLATE_VARIABLE_RENDERERS.amount("۲۵۰۰۰۰")).toEqual({ ok: true, value: "۲۵۰٬۰۰۰" });
    expect(TEMPLATE_VARIABLE_RENDERERS.amount(0)).toEqual({ ok: false });
    expect(TEMPLATE_VARIABLE_RENDERERS.amount(-5)).toEqual({ ok: false });
    expect(TEMPLATE_VARIABLE_RENDERERS.amount(1.5)).toEqual({ ok: false });
  });

  it("renders a date in the Jalali calendar", () => {
    // 2026-10-28 is 1405-08-06.
    expect(TEMPLATE_VARIABLE_RENDERERS.date("2026-10-28")).toEqual({ ok: true, value: "۱۴۰۵/۰۸/۰۶" });
    expect(TEMPLATE_VARIABLE_RENDERERS.date("not a date")).toEqual({ ok: false });
  });

  it("keeps an order number legible and refuses backend syntax", () => {
    expect(TEMPLATE_VARIABLE_RENDERERS.order_number("1042")).toEqual({ ok: true, value: "1042" });
    expect(TEMPLATE_VARIABLE_RENDERERS.order_number("A-1042")).toEqual({ ok: true, value: "A-1042" });
    expect(TEMPLATE_VARIABLE_RENDERERS.order_number("1042; DROP TABLE")).toEqual({ ok: false });
    // A `%` never survives a value, so a caller cannot smuggle a token slot
    // through the data it fills one with.
    expect(TEMPLATE_VARIABLE_RENDERERS.order_number("%token")).toEqual({
      ok: true,
      value: "token",
    });
  });
});

describe("the registry itself", () => {
  it("exposes exactly the variables the migration allows", () => {
    // 0264's CHECK constraint pins this list; a new renderer means a migration.
    expect(Object.keys(TEMPLATE_VARIABLE_RENDERERS).sort()).toEqual([
      "amount",
      "code",
      "customer_name",
      "date",
      "order_number",
      "store_name",
    ]);
    expect(isTemplateVariable("invoice_url")).toBe(false);
    expect(isTemplateVariable("amount")).toBe(true);
  });

  it("has a sample for every variable", () => {
    for (const name of Object.keys(TEMPLATE_VARIABLE_RENDERERS) as TemplateVariable[]) {
      expect(SAMPLE_TEMPLATE_VALUES[name]).toBeDefined();
      expect(TEMPLATE_VARIABLE_RENDERERS[name](SAMPLE_TEMPLATE_VALUES[name]).ok).toBe(true);
    }
  });
});

describe("renderTemplateSample — what a tenant sees before approving", () => {
  it("renders the seeded library bodies", () => {
    expect(
      renderTemplateSample({ body: "کد ورود شما به بیزامیز: %token", variables: ["code"] }),
    ).toBe("کد ورود شما به بیزامیز: 482913");
    expect(renderTemplateSample({ body: BODY, variables: VARIABLES })).toBe(
      "سارا محمدی عزیز، سفارش شما در فروشگاه نمونه آمادهٔ تحویل است.",
    );
  });

  it("falls back to the body rather than an empty row", () => {
    expect(renderTemplateSample({ body: "%token2", variables: ["code"] })).toBe("%token2");
  });
});
