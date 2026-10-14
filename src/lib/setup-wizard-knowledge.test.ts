import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEPS } from "@/app/setup/steps";

const article = readFileSync(join(process.cwd(), "scripts/knowledge-seed/articles/setup-wizard.md"), "utf8");

describe("setup wizard knowledge article", () => {
  it("names the current wizard steps in their canonical order rather than documenting a stale sequence", () => {
    let previousPosition = -1;
    for (const step of STEPS) {
      const position = article.indexOf(`**${step.title}**`);
      expect(position, step.id).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
    expect(article).toContain("**پایان راه‌اندازی**");
    expect(article).not.toMatch(/\d+\.\s+\*\*روش‌های پرداخت\*\*/);
  });

  it("documents the current readiness contract and industry-specific requirements", () => {
    expect(article).toContain("ترجیحات کسب‌وکار");
    expect(article).toContain("دست‌کم یک سرفصل حساب");
    expect(article).toContain("تنظیم مالیات ذخیره شده باشد");
    expect(article).toContain("روش بهای تمام‌شده ذخیره شده");
    expect(article).toContain("یک قلم فعال و قابل فروش در منو");
    expect(article).toContain("داده‌های لازم واقعاً ذخیره شده باشند");
    expect(article).toContain("به کافه/رستوران تغییر کند");
  });
});
