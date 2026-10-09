import { describe, expect, it } from "vitest";
import { accountingAssistantContext, accountingSectionHeading } from "./accounting-headings";
import { ACCOUNTING_SECTIONS } from "./accounting-nav";

describe("accountingSectionHeading", () => {
  it("names every section by its own menu label, not the app's generic heading", () => {
    for (const section of ACCOUNTING_SECTIONS) {
      const heading = accountingSectionHeading(section.key);
      if (section.key === "ledger") {
        // The one deliberate exception: this page *is* «فضای کار حسابداری» —
        // the workspace landing whose menu row says those exact words — so its
        // heading must say them too. Every other section keeps its own name.
        expect(heading.title).toBe("فضای کار حسابداری");
      } else {
        expect(heading.title).not.toBe("فضای کار حسابداری");
      }
      expect(heading.description.length).toBeGreaterThan(0);
    }
    expect(accountingSectionHeading("ledger").title).toBe("فضای کار حسابداری");
    expect(accountingSectionHeading("trial-balance").title).toBe("تراز آزمایشی");
    expect(accountingSectionHeading("manual").title).toBe("ثبت سند دستی");
    expect(accountingSectionHeading("settings").title).toBe("تنظیمات حسابداری");
  });
});

describe("accountingAssistantContext", () => {
  it("names the section and carries no figures", () => {
    const text = accountingAssistantContext("fixed-assets");
    expect(text).toContain("«دارایی‌های ثابت»");
    expect(text).not.toMatch(/[0-9۰-۹]/);
  });
});
