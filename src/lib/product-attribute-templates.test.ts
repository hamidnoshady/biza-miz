import { describe, expect, it } from "vitest";
import {
  PRODUCT_ATTRIBUTE_TEMPLATES,
  attributeTemplateByKey,
  attributeTemplatesFor,
  defaultAttributeTemplateFor,
  invalidTemplateDefinition,
} from "./product-attribute-templates";
import { INDUSTRIES } from "./industries";
import { ATTRIBUTE_OPTIONS_MAX_COUNT } from "./product-attributes";

describe("product attribute templates (#1567 P0 2.2–2.3)", () => {
  it("has unique keys and every key is addressable", () => {
    const keys = PRODUCT_ATTRIBUTE_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(attributeTemplateByKey(key)?.key).toBe(key);
  });

  it("keeps every definition within the attribute master's limits", () => {
    for (const template of PRODUCT_ATTRIBUTE_TEMPLATES) {
      expect(invalidTemplateDefinition(template), template.key).toBeNull();
      for (const definition of template.attributes) {
        expect(definition.options.length).toBeLessThanOrEqual(ATTRIBUTE_OPTIONS_MAX_COUNT);
      }
    }
  });

  it("offers the fashion shop the three category presets and seeds apparel by default", () => {
    const offered = attributeTemplatesFor("fashion_apparel").map((template) => template.key);
    expect(offered).toEqual(["fashion_apparel", "fashion_footwear", "fashion_bags_accessories"]);

    const seeded = defaultAttributeTemplateFor("fashion_apparel");
    expect(seeded?.key).toBe("fashion_apparel");
    // Provisioning seeds exactly one template, and only industries that have
    // one get any — no other industry's provisioning path may change.
    expect(PRODUCT_ATTRIBUTE_TEMPLATES.filter((t) => t.provisionByDefault)).toHaveLength(1);
    for (const industry of INDUSTRIES) {
      if (industry !== "fashion_apparel") expect(defaultAttributeTemplateFor(industry)).toBeNull();
    }
  });

  it("covers the fashion axes the epic names: sizes, colours, care, brand, season", () => {
    const apparel = attributeTemplateByKey("fashion_apparel")!;
    const names = apparel.attributes.map((definition) => definition.name);
    for (const axis of ["سایز", "رنگ", "طرح", "جنس", "جنسیت", "فصل", "کالکشن", "برند", "مراقبت"]) {
      expect(names, axis).toContain(axis);
    }
    // International shoe sizes ride their own category template (۳۶–۴۵).
    const footwear = attributeTemplateByKey("fashion_footwear")!;
    const shoeSizes = footwear.attributes.find((definition) => definition.name === "سایز کفش")!;
    expect(shoeSizes.options).toEqual(["36", "37", "38", "39", "40", "41", "42", "43", "44", "45"]);
  });

  it("gates every template to an industry that exists", () => {
    for (const template of PRODUCT_ATTRIBUTE_TEMPLATES) {
      expect(template.industries.length).toBeGreaterThan(0);
      for (const industry of template.industries) expect(INDUSTRIES).toContain(industry);
      expect(template.label.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
    }
  });
});
