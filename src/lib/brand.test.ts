import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { BRAND_NAME_EN, BRAND_NAME_FA, brandLocale, brandName, brandTagline } from "./brand";

const require = createRequire(import.meta.url);

describe("brand", () => {
  it("spells the name exactly as Hamid decided", () => {
    expect(BRAND_NAME_EN).toBe("Bizamiz");
    expect(BRAND_NAME_FA).toBe("بیزامیز");
  });

  it("shows the Persian name for Persian locales and by default", () => {
    for (const l of ["fa", "fa-IR", "FA", " fa-ir ", "", undefined, null]) {
      expect(brandName(l)).toBe("بیزامیز");
    }
  });

  it("shows the English name for every other locale", () => {
    for (const l of ["en", "en-US", "EN-gb", "de", "ar"]) {
      expect(brandName(l)).toBe("Bizamiz");
    }
  });

  it("keeps the tagline in the same language as the name", () => {
    expect(brandLocale("en-US")).toBe("en");
    expect(brandTagline("en")).toBe("Business management platform");
    expect(brandTagline("fa")).toBe("پلتفرم مدیریت کسب‌وکار");
  });

  it("is mirrored exactly by the desktop shell", () => {
    const desktop = require("../../electron/brand.js") as {
      BRAND_NAME_FA: string;
      BRAND_NAME_EN: string;
      brandName: (locale?: string | null) => string;
      byLocale: (locale: string, variants: { fa: string; en: string }) => string;
    };
    expect(desktop.BRAND_NAME_FA).toBe(BRAND_NAME_FA);
    expect(desktop.BRAND_NAME_EN).toBe(BRAND_NAME_EN);
    for (const l of ["fa", "fa-IR", "en", "en-US", "", undefined]) {
      expect(desktop.brandName(l)).toBe(brandName(l));
    }
    expect(desktop.byLocale("fa-IR", { fa: "الف", en: "a" })).toBe("الف");
    expect(desktop.byLocale("en-US", { fa: "الف", en: "a" })).toBe("a");
  });
});
