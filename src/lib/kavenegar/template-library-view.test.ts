import { describe, expect, it } from "vitest";
import { SUPPLIER_NAME_PATTERN } from "../managed-services/inventory";
import { VARIABLE_LABELS, libraryEntryView, splitLibrary } from "./template-library-view";

const entry = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "آمادهٔ تحویل سفارش",
  purpose: "transactional" as const,
  sample: "سارا محمدی عزیز، سفارش شما در فروشگاه نمونه آمادهٔ تحویل است.",
  variables: ["customer_name", "store_name"],
  alreadyAdded: false,
};

describe("libraryEntryView — what a business owner reads", () => {
  it("names each declared variable in Persian, in the order the message uses them", () => {
    const view = libraryEntryView(entry);
    expect(view.variables.map((variable) => variable.label)).toEqual(["نام مشتری", "نام کسب‌وکار"]);
    // Order is the mapping (%token, %token2), so it is not a set.
    expect(view.variables.map((variable) => variable.name)).toEqual(["customer_name", "store_name"]);
  });

  it("says which automations the message can serve, using the send path's own check", () => {
    // An order-ready message fills a name and a store, so it serves that event
    // and not a payment receipt — computed by `checkTriggerTemplate`, which is
    // what `sendManagedLookup` refuses with, so the screen cannot offer a
    // pairing the server would reject.
    expect(libraryEntryView(entry).triggers.map((trigger) => trigger.key)).toEqual(["order_ready"]);
    expect(
      libraryEntryView({ ...entry, variables: ["amount", "store_name"] }).triggers.map((t) => t.key),
    ).toEqual(["payment_received"]);
  });

  it("offers no automation for a message no event can fill", () => {
    expect(libraryEntryView({ ...entry, variables: ["code"] }).triggers).toEqual([]);
    expect(libraryEntryView({ ...entry, variables: [] }).triggers).toEqual([]);
  });

  it("drops a variable outside the closed vocabulary instead of showing `%token4`", () => {
    // Rendering the raw key would be showing a tenant our notation; and nothing
    // could ever fill it, so it must not appear as a requirement either.
    const view = libraryEntryView({ ...entry, variables: ["customer_name", "unknown_thing"] });
    expect(view.variables.map((variable) => variable.name)).toEqual(["customer_name"]);
  });

  it("carries only first-party words", () => {
    const view = libraryEntryView(entry);
    expect(SUPPLIER_NAME_PATTERN.test(JSON.stringify(view))).toBe(false);
    expect(view.purposeLabel).toBe("اطلاع‌رسانی تراکنشی");
    for (const variable of view.variables) expect(VARIABLE_LABELS[variable.name]).toBe(variable.label);
  });
});

describe("splitLibrary — an added message stays visible, marked", () => {
  it("keeps what was added on the screen rather than removing it", () => {
    const added = { ...entry, id: "22222222-2222-4222-8222-222222222222", alreadyAdded: true };
    const { available, added: done } = splitLibrary([libraryEntryView(entry), libraryEntryView(added)]);
    expect(available.map((view) => view.id)).toEqual([entry.id]);
    expect(done.map((view) => view.id)).toEqual([added.id]);
  });
});
