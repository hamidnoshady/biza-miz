import { describe, expect, it } from "vitest";
import {
  buildProductDescriptionUserPrompt,
  parseProductDescriptionReply,
  PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
} from "./product-description-ai";

describe("product description prompt", () => {
  it("tells the model to use only recorded facts and never to invent specs, prices or claims", () => {
    expect(PRODUCT_DESCRIPTION_SYSTEM_PROMPT).toContain("فقط از واقعیت‌هایی استفاده کن");
    expect(PRODUCT_DESCRIPTION_SYSTEM_PROMPT).toContain("قیمت");
    expect(PRODUCT_DESCRIPTION_SYSTEM_PROMPT).toContain("JSON");
  });

  it("lists only the facts it was given, and omits the blanks", () => {
    const prompt = buildProductDescriptionUserPrompt({
      name: " دستبند چرم ",
      sku: "B-1",
      brand: "  ",
      unit: "عدد",
      attributes: [
        { name: "رنگ", value: "قهوه‌ای" },
        { name: "", value: "x" },
      ],
      instruction: "لحن رسمی",
    });
    expect(prompt).toContain("نام محصول: دستبند چرم");
    expect(prompt).toContain("کد کالا (SKU): B-1");
    expect(prompt).toContain("رنگ: قهوه‌ای");
    expect(prompt).toContain("دستور مالک: لحن رسمی");
    expect(prompt).not.toContain("برند");
    expect(prompt).not.toContain("x");
  });

  it("includes what the owner already wrote so the draft can improve it", () => {
    const prompt = buildProductDescriptionUserPrompt({ name: "کالا", existingShort: "قبلی کوتاه", existingLong: "قبلی کامل" });
    expect(prompt).toContain("توضیح کوتاه فعلی: قبلی کوتاه");
    expect(prompt).toContain("توضیح کامل فعلی: قبلی کامل");
  });
});

describe("parseProductDescriptionReply", () => {
  it("reads a plain JSON reply", () => {
    expect(parseProductDescriptionReply('{"short":"کوتاه","long":"کامل"}')).toEqual({
      shortDescription: "کوتاه",
      longDescription: "کامل",
    });
  });

  it("reads a reply wrapped in a code fence or a sentence", () => {
    expect(parseProductDescriptionReply('```json\n{"short":"الف","long":"ب"}\n```')).toEqual({
      shortDescription: "الف",
      longDescription: "ب",
    });
    expect(parseProductDescriptionReply('این هم پیش‌نویس: {"short":"الف","long":"ب"} تمام.')).toMatchObject({ shortDescription: "الف" });
  });

  it("strips markup the model was told not to produce", () => {
    const draft = parseProductDescriptionReply('{"short":"**مهم** <b>کوتاه</b>","long":"# عنوان\\nمتن"}');
    expect(draft?.shortDescription).toBe("مهم کوتاه");
    expect(draft?.longDescription).toBe("عنوان\nمتن");
  });

  it("keeps a draft within the stored limit, cutting at a sentence boundary", () => {
    const sentence = "این یک جملهٔ کوتاه است. ";
    const draft = parseProductDescriptionReply(JSON.stringify({ short: sentence.repeat(200), long: "ب" }));
    expect(draft!.shortDescription.length).toBeLessThanOrEqual(1000);
    expect(draft!.shortDescription.endsWith(".")).toBe(true);
  });

  it("returns null — never a blank draft — when there is nothing usable", () => {
    expect(parseProductDescriptionReply("متن بدون JSON")).toBeNull();
    expect(parseProductDescriptionReply("{not json}")).toBeNull();
    expect(parseProductDescriptionReply('{"short":"","long":"  "}')).toBeNull();
    expect(parseProductDescriptionReply("[]")).toBeNull();
  });

  it("accepts one description without the other", () => {
    expect(parseProductDescriptionReply('{"short":"فقط کوتاه"}')).toEqual({ shortDescription: "فقط کوتاه", longDescription: "" });
  });
});
