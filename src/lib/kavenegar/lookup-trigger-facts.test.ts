import { describe, expect, it } from "vitest";
import {
  MANAGED_LOOKUP_TRIGGERS,
  checkTriggerTemplate,
  isManagedLookupTrigger,
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
