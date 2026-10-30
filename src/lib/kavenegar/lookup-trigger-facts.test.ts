import { describe, expect, it } from "vitest";
import {
  MANAGED_LOOKUP_TRIGGERS,
  TRIGGER_CODE_LABELS,
  checkTriggerTemplate,
  isManagedLookupTrigger,
  previewTriggerMessage,
  triggerCodeLabel,
  triggerEventKey,
  triggerValues,
  unsupportedTriggerVariables,
} from "./lookup-trigger-facts";

describe("the trigger vocabulary is closed", () => {
  it("has exactly the two business events the issue names", () => {
    expect([...MANAGED_LOOKUP_TRIGGERS]).toEqual(["order_ready", "payment_received"]);
  });

  it("refuses the login code, because auth must not ride on a tenant wallet", () => {
    // Issue #902 DoD #9: a login OTP still works when Growth is off, the child
    // account is suspended or the marketing wallet is empty. Every trigger here
    // is a send on the *child's* key charged to the *business's* wallet, so
    // "login_code" in this list would be that outage. The migration's CHECK
    // says the same thing in the schema.
    expect(isManagedLookupTrigger("login_code")).toBe(false);
    expect(isManagedLookupTrigger("order_ready")).toBe(true);
    expect(isManagedLookupTrigger("payment_received")).toBe(true);
    expect(isManagedLookupTrigger(undefined)).toBe(false);
    expect(isManagedLookupTrigger("")).toBe(false);
  });
});

describe("triggerValues — the facts an event really has", () => {
  it("fills the order-ready variables from the order itself", () => {
    expect(
      triggerValues(
        "order_ready",
        { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "1042" },
        ["customer_name", "store_name", "order_number"],
      ),
    ).toEqual({ customer_name: "سارا", store_name: "کافهٔ نمونه", order_number: "1042" });
  });

  it("passes an amount through as an integer, letting the renderer format it", () => {
    // Formatting lives in template-variables.ts (Persian digits, grouping). A
    // pre-formatted string here would be a second, unaudited formatter in front
    // of the one that already refuses bad input.
    expect(
      triggerValues(
        "payment_received",
        { amountRial: 250_000, storeName: "کافهٔ نمونه", receivedAt: new Date("2026-10-28T09:00:00Z") },
        ["amount", "store_name"],
      ),
    ).toEqual({ amount: 250_000, store_name: "کافهٔ نمونه" });
  });

  it("omits a fact the event does not have rather than sending a blank", () => {
    // An anonymous walk-in order has no customer name. The renderer answers
    // `variable_missing` for the absent value and the send is refused, which is
    // the honest outcome — a message that opens with « عزیز،» is not.
    const values = triggerValues(
      "order_ready",
      { customerName: null, storeName: "کافهٔ نمونه", orderNumber: null },
      ["customer_name", "store_name"],
    );
    expect(values).toEqual({ store_name: "کافهٔ نمونه" });
    expect(values).not.toHaveProperty("customer_name");
  });

  it("ignores a declared variable the event cannot fill", () => {
    const values = triggerValues(
      "order_ready",
      { customerName: "سارا", storeName: "کافه", orderNumber: "1" },
      ["customer_name", "code"],
    );
    expect(values).not.toHaveProperty("code");
  });
});

describe("checkTriggerTemplate — a mapping that cannot be filled never reaches the provider", () => {
  it("accepts a template whose variables the event supplies", () => {
    expect(checkTriggerTemplate("order_ready", ["customer_name", "store_name"])).toBeNull();
    expect(checkTriggerTemplate("payment_received", ["amount", "store_name"])).toBeNull();
  });

  it("refuses a template with no declared variables", () => {
    // Same refusal §5d makes: without a positional mapping the value would land
    // in the wrong sentence.
    expect(checkTriggerTemplate("order_ready", [])).toBe("template_variables_undeclared");
  });

  it("refuses a template that wants a fact this event does not have", () => {
    expect(unsupportedTriggerVariables("order_ready", ["customer_name", "amount"])).toEqual(["amount"]);
    expect(checkTriggerTemplate("order_ready", ["customer_name", "amount"])).toBe(
      "trigger_variable_unsupported",
    );
    // The login code is exactly this failure: an order event has no code.
    expect(checkTriggerTemplate("order_ready", ["code"])).toBe("trigger_variable_unsupported");
  });
});

describe("triggerEventKey — the identity of the fact, not of the attempt", () => {
  it("is stable across replays of one order and different for another", () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    expect(triggerEventKey("order_ready", orderId)).toBe(`order:${orderId}`);
    expect(triggerEventKey("order_ready", orderId)).toBe(triggerEventKey("order_ready", orderId));
    expect(triggerEventKey("payment_received", orderId)).toBe(`payment:${orderId}`);
    expect(triggerEventKey("order_ready", "22222222-2222-4222-8222-222222222222")).not.toBe(
      triggerEventKey("order_ready", orderId),
    );
  });
});

describe("the tenant's preview is the message, not an example (issue #902 §9 item 0)", () => {
  it("renders the template through the same functions the dispatcher uses", () => {
    const preview = previewTriggerMessage({
      trigger: "order_ready",
      body: "%token سلام، سفارش %token2 از %token3 آمادهٔ تحویل است.",
      declared: ["customer_name", "store_name", "order_number"],
    });
    // A real render: the sample customer's name is in it, and no token is left.
    // The order number is rendered by the shared renderer, which leaves a plain
    // number in Latin digits — the preview deliberately does not add a second
    // formatter in front of the one that already owns this.
    expect(preview).toBe("سارا محمدی سلام، سفارش فروشگاه نمونه از 1042 آمادهٔ تحویل است.");
    expect(preview).not.toMatch(/%token/);
  });

  it("renders a payment receipt with the money formatted, not the raw rial", () => {
    const preview = previewTriggerMessage({
      trigger: "payment_received",
      body: "پرداخت %token به مبلغ %token2 در %token3 ثبت شد.",
      declared: ["store_name", "amount", "date"],
    });
    expect(preview).toContain("فروشگاه نمونه");
    // The amount renders as money in Persian digits with the platform's
    // separator, and the Jalali date the renderer produces — not the raw rial
    // integer and not an ISO string.
    expect(preview).toContain("۲۵۰٬۰۰۰");
    expect(preview).not.toMatch(/250000|2026-10-28/);
  });

  it("says nothing rather than something blank when the pair cannot be rendered", () => {
    // A template declaring a variable the event cannot fill must not preview as
    // an empty message: "we cannot show this" and "the message is blank" are
    // different claims, and only one of them is true.
    expect(
      previewTriggerMessage({
        trigger: "order_ready",
        body: "%token سلام %token2",
        declared: ["customer_name", "amount"],
      }),
    ).toBeNull();

    expect(
      previewTriggerMessage({ trigger: "order_ready", body: "بدون متغیر", declared: [] }),
    ).toBeNull();
  });
});

describe("a stored code becomes a first-party sentence", () => {
  it("translates the refusals a tenant can act on", () => {
    expect(triggerCodeLabel("no_consent")).toBe("مشتری اجازهٔ دریافت پیامک نداده است");
    expect(triggerCodeLabel("insufficient_credit")).toBe("اعتبار کیف پول کافی نبود");
    expect(triggerCodeLabel(null)).toBeNull();
  });

  it("never echoes a code it does not know, and never a supplier's words", () => {
    // A future or provider-shaped code must not reach a tenant screen verbatim.
    expect(triggerCodeLabel("http_429")).toBe("پیام ارسال نشد");
    expect(triggerCodeLabel("kavenegar_418")).toBe("پیام ارسال نشد");
    for (const label of Object.values(TRIGGER_CODE_LABELS)) {
      expect(label).not.toMatch(/kavenegar|provider|HTTP|429|418/i);
    }
  });
});
