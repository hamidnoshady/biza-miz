import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./product-add-section.tsx", import.meta.url), "utf8");

describe("add-product interaction regressions", () => {
  it("preserves the barcode when the final variant is removed", () => {
    expect(source).toContain("function removeVariantRow(variantId: DraftId)");
    expect(source).toContain("barcode: finalVariant?.barcode || current.barcode");
    expect(source).toContain("onClick={() => removeVariantRow(variant.id)}");
  });

  it("migrates older drafts by definition identity and blocks stale values instead of dropping them", () => {
    expect(source).toContain("migrateDraftAttributeValues(restored.variants, definitions ?? [])");
    expect(source).toContain("definitionId,");
    expect(source).toContain("reconciliationIssues.length > 0");
    expect(source).not.toContain("activeAttributeNames.has(name) && value.trim()");
  });

  it("prevents the UI from exceeding the server's variant limit", () => {
    expect(source).toContain("disabled={form.variants.length >= 100 || activeDefinitions.length === 0}");
    expect(source).toContain("حداکثر ۱۰۰ تنوع ثبت شده است");
  });
});
