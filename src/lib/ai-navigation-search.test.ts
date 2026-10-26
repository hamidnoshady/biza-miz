import { describe, expect, it } from "vitest";
import { findAuthorizedAiDestinations, type AuthorizedAiDestination } from "./ai-navigation-search";

const entries: AuthorizedAiDestination[] = [
  { id: "/accounting/orders", href: "/accounting/orders", label: "سفارش‌ها" },
  { id: "/accounting/expenses", href: "/accounting/expenses", label: "هزینه‌ها" },
  { id: "/crm/overview", href: "/crm/overview", label: "ارتباط با مشتری" },
];

describe("AI feature navigation resolves registered candidates only", () => {
  it("finds Persian destinations and normalizes Arabic letters", () => {
    const result = findAuthorizedAiDestinations(entries, "هزينه ها");
    expect(result).toEqual([entries[1]]);
  });

  it("uses only the supplied authorized candidates, never a guessed URL", () => {
    const onlyCrm = [entries[2]];
    expect(findAuthorizedAiDestinations(onlyCrm, "حسابداری")).toEqual([]);
    expect(findAuthorizedAiDestinations(onlyCrm, "CRM")).toEqual([entries[2]]);
  });

  it("returns nothing for blank or one-letter queries", () => {
    expect(findAuthorizedAiDestinations(entries, " ")).toEqual([]);
    expect(findAuthorizedAiDestinations(entries, "x")).toEqual([]);
  });

  it("ranks stronger matches first and bounds suggestions", () => {
    const result = findAuthorizedAiDestinations(entries, "accounting expenses");
    expect(result[0]).toEqual(entries[1]);
    expect(result.length).toBeLessThanOrEqual(8);
  });
});
