import { describe, expect, it } from "vitest";
import { ITEM_SOURCE_SQL, itemSourceLabel } from "./item-source";

describe("itemSourceLabel", () => {
  it("names the store and its id in Persian", () => {
    expect(itemSourceLabel({ provider: "woocommerce", remoteId: "501" })).toBe("ووکامرس · شناسه ۵۰۱");
    expect(itemSourceLabel({ provider: "holoo", remoteId: "12" })).toBe("هلو · شناسه ۱۲");
  });

  it("says nothing for a row no integration owns", () => {
    expect(itemSourceLabel(null)).toBeNull();
    expect(itemSourceLabel(undefined)).toBeNull();
    expect(itemSourceLabel({ provider: "woocommerce", remoteId: "" })).toBeNull();
  });

  it("reads the product mappings through the local-id index", () => {
    expect(ITEM_SOURCE_SQL).toContain("m.entity_type IN ('product', 'holoo_goods') AND m.local_id = i.id");
  });
});
