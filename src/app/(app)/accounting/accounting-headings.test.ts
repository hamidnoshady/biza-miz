import { describe, expect, it } from "vitest";
import { accountingAssistantContext, accountingSectionHeading } from "./accounting-headings";
import { ACCOUNTING_SECTIONS } from "./accounting-nav";

describe("accountingSectionHeading", () => {
  it("names every section by its own menu label, not the app's generic heading", () => {
    for (const section of ACCOUNTING_SECTIONS) {
      const heading = accountingSectionHeading(section.key);
      expect(heading.title).not.toBe("فضای کار حسابداری");
      expect(heading.description.length).toBeGreaterThan(0);
    }
    expect(accountingSectionHeading("manual").title).toBe("ثبت سند دستی");
    expect(accountingSectionHeading("settings").title).toBe("تنظیمات حسابداری");
  });

  it("gives the canonical chart of accounts its own page header (issue #824 §13)", () => {
    const heading = accountingSectionHeading("chart-of-accounts");
    expect(heading.title).toBe("سرفصل حساب‌ها");
    // The header is owned by the route, so the section card inside it must not
    // repeat the same title.
    expect(heading.description.length).toBeGreaterThan(0);
    expect(heading.description).toMatch(/حساب/);
  });
});

describe("accountingAssistantContext", () => {
  it("names the section and carries no figures", () => {
    const text = accountingAssistantContext("fixed-assets");
    expect(text).toContain("«دارایی‌های ثابت»");
    expect(text).not.toMatch(/[0-9۰-۹]/);
  });
});
