import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractGuideStepLines } from "./kb-step-excerpt";

/** Issue #1239 / ESH-90 — the published article → inline wizard excerpt. */
const article = readFileSync(
  join(process.cwd(), "scripts/knowledge-seed/articles/setup-wizard.md"),
  "utf8",
);

describe("extractGuideStepLines", () => {
  it("returns the sentences after the step's bold heading, without the heading", () => {
    const lines = extractGuideStepLines(
      "1. **اطلاعات کسب‌وکار** — نام و شعبه را ثبت کنید. لوگو اختیاری است.",
      "اطلاعات کسب‌وکار",
    );
    expect(lines).toEqual(["نام و شعبه را ثبت کنید.", "لوگو اختیاری است."]);
  });

  it("extracts a real step from the shipped article", () => {
    const lines = extractGuideStepLines(article, "انتخاب برنامه‌های کسب‌وکار");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(4);
    // No Markdown survives into the rendered help.
    for (const line of lines) {
      expect(line).not.toContain("**");
      expect(line).not.toContain("](");
    }
  });

  it("strips a Markdown link down to its label", () => {
    const lines = extractGuideStepLines(
      "1. **ورود منو** — از [مدیریت منو](/knowledge/a/menu-management) قابل ویرایش است.",
      "ورود منو",
    );
    expect(lines).toEqual(["از مدیریت منو قابل ویرایش است."]);
  });

  it("caps the excerpt so a step never renders a wall of text", () => {
    const long = Array.from({ length: 9 }, (_, i) => `جملهٔ ${i + 1}.`).join(" ");
    expect(extractGuideStepLines(`**گام** ${long}`, "گام", 3)).toHaveLength(3);
  });

  it("fails closed on a missing marker, empty body or heading with no prose", () => {
    expect(extractGuideStepLines(article, "مرحلهٔ ناموجود")).toEqual([]);
    expect(extractGuideStepLines("", "اطلاعات کسب‌وکار")).toEqual([]);
    expect(extractGuideStepLines("**اطلاعات کسب‌وکار** —", "اطلاعات کسب‌وکار")).toEqual([]);
  });
});
