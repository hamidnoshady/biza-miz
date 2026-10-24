import { describe, expect, it } from "vitest";
import {
  NON_SELLABLE_WOO_TYPE_STRINGS,
  UNTRACKED_WOO_TYPE_STRINGS,
  VARIATION_WOO_TYPE_STRINGS,
  catalogueRowMatches,
  catalogueSummary,
  catalogueTypeFacets,
  classifyWooProductType,
  filterCatalogueRows,
  formatWooVariationAttribute,
  inferWooProductType,
  isSellableWooProduct,
  isWooAttributeTaxonomy,
  paginateCatalogueRows,
  planWooCatalogueWrite,
  resolveWooOrderLine,
  shouldImportWooOrder,
  sortCatalogueRows,
  sortWooTerms,
  wooAttributeSlug,
  wooLineCandidateIds,
  wooLineParentFallback,
  wooProductRemoteIds,
  wooProductShape,
  wooTaxonomyLabel,
  wooTermDepth,
  wooTermPath,
  wooUpdatePath,
  wooVariationAttributes,
  wooVariationDisplayName,
  type CatalogueListRow,
} from "./woo-catalogue";
import type { WooOrderLineItem, WooProduct } from "./woocommerce-client";

function line(overrides: Partial<WooOrderLineItem> = {}): WooOrderLineItem {
  return {
    id: 1,
    name: "تی‌شرت",
    product_id: 10,
    quantity: 1,
    price: "100",
    total: "100",
    ...overrides,
  };
}

function product(overrides: Partial<WooProduct> = {}): WooProduct {
  return {
    id: 1,
    type: "simple",
    name: "تی‌شرت",
    sku: "TS-1",
    price: "100",
    regular_price: "100",
    manage_stock: true,
    stock_quantity: 5,
    stock_status: "instock",
    status: "publish",
    ...overrides,
  };
}

describe("classifyWooProductType", () => {
  it("names every core WooCommerce type", () => {
    expect(classifyWooProductType("simple")).toBe("simple");
    expect(classifyWooProductType("variable")).toBe("variable");
    expect(classifyWooProductType("variation")).toBe("variation");
    expect(classifyWooProductType("grouped")).toBe("grouped");
    expect(classifyWooProductType("external")).toBe("external");
  });

  it("is case- and whitespace-insensitive, because WooCommerce is not consistent", () => {
    expect(classifyWooProductType("  Variable ")).toBe("variable");
    expect(classifyWooProductType("VARIATION")).toBe("variation");
  });

  it("folds the extension aliases onto the shape they behave like", () => {
    expect(classifyWooProductType("affiliate")).toBe("external");
    expect(classifyWooProductType("yith_bundle")).toBe("bundle");
    expect(classifyWooProductType("variable-subscription")).toBe("variable");
    expect(classifyWooProductType("subscription_variation")).toBe("variation");
  });

  it("returns unknown rather than throwing for a type it has never heard of", () => {
    expect(classifyWooProductType("woosb")).toBe("unknown");
    expect(classifyWooProductType("")).toBe("unknown");
    expect(classifyWooProductType(undefined)).toBe("unknown");
  });
});

describe("wooProductShape", () => {
  it("treats a variable product as an unsellable container", () => {
    const shape = wooProductShape("variable");
    expect(shape.sellable).toBe(false);
    expect(shape.container).toBe(true);
    expect(shape.itemKind).toBe("variant_parent");
    expect(shape.stockTracked).toBe(false);
  });

  it("treats a variation as the sellable unit", () => {
    const shape = wooProductShape("variation");
    expect(shape.sellable).toBe(true);
    expect(shape.container).toBe(false);
    expect(shape.itemKind).toBe("variant_child");
    expect(shape.stockTracked).toBe(true);
  });

  it("sells an external product but never tracks stock for it", () => {
    const shape = wooProductShape("external");
    expect(shape.sellable).toBe(true);
    expect(shape.stockTracked).toBe(false);
  });

  it("defaults an unrecognised type to sellable simple, never to skipped", () => {
    // The alternative is dropping the product from the catalogue entirely,
    // which is a worse answer for a shop running an extension we don't know.
    expect(wooProductShape("woosb")).toMatchObject({ sellable: true, itemKind: "simple" });
  });
});

describe("inferWooProductType", () => {
  it("trusts the declared type when it is one it knows", () => {
    expect(inferWooProductType({ type: "variable", parent_id: 7 })).toBe("variable");
  });

  it("reads a missing type from parent_id — the one inference that is always safe", () => {
    expect(inferWooProductType({ parent_id: 7 })).toBe("variation");
    expect(inferWooProductType({ type: "", parent_id: 7 })).toBe("variation");
  });

  it("falls back to unknown for an orphan with no type", () => {
    expect(inferWooProductType({})).toBe("unknown");
  });

  it("decides sellability from the inferred type", () => {
    expect(isSellableWooProduct({ type: "variable" })).toBe(false);
    expect(isSellableWooProduct({ type: "variation" })).toBe(true);
    expect(isSellableWooProduct({ type: "grouped" })).toBe(false);
    expect(isSellableWooProduct({ parent_id: 3 })).toBe(true);
  });
});

describe("resolveWooOrderLine", () => {
  it("prefers variation_id — the row that actually carries the stock", () => {
    // This is the whole fix: the old code read product_id, which on a
    // variation line is the *parent*, and the parent is a container with no
    // stock row. Revenue posted; stock and COGS vanished.
    expect(resolveWooOrderLine(line({ product_id: 10, variation_id: 42 }))).toEqual({
      remoteId: "42",
      via: "variation",
      variationId: 42,
      productId: 10,
    });
  });

  it("uses product_id for a simple product line", () => {
    expect(resolveWooOrderLine(line({ product_id: 10, variation_id: 0 }))).toEqual({
      remoteId: "10",
      via: "product",
      productId: 10,
    });
  });

  it("tolerates a variation_id that arrived as a string", () => {
    // The plugin serialises through JSON; WooCommerce is not strict about
    // numeric types across REST versions.
    expect(resolveWooOrderLine(line({ product_id: 10, variation_id: "42" as unknown as number }))).toMatchObject({
      remoteId: "42",
      via: "variation",
    });
  });

  it("ignores a variation_id equal to the product_id", () => {
    expect(resolveWooOrderLine(line({ product_id: 10, variation_id: 10 }))).toMatchObject({
      remoteId: "10",
      via: "product",
    });
  });

  it("reports a line with nothing to resolve rather than resolving to 0", () => {
    expect(resolveWooOrderLine(line({ product_id: 0, variation_id: 0 }))).toEqual({ remoteId: null, via: "none" });
  });
});

describe("wooLineCandidateIds", () => {
  it("lists the variation before the parent, deduped", () => {
    expect(wooLineCandidateIds(line({ product_id: 10, variation_id: 42 }))).toEqual(["42", "10"]);
    expect(wooLineCandidateIds(line({ product_id: 10, variation_id: 10 }))).toEqual(["10"]);
  });

  it("names the parent as the fallback for an unmapped variation", () => {
    expect(wooLineParentFallback(line({ product_id: 10, variation_id: 42 }))).toBe("10");
    expect(wooLineParentFallback(line({ product_id: 10 }))).toBeNull();
  });
});

describe("variation naming", () => {
  it("renders a variation as its parent plus its attributes", () => {
    expect(
      wooVariationDisplayName("تی‌شرت", [
        { name: "رنگ", option: "قرمز" },
        { name: "سایز", option: "L" },
      ]),
    ).toBe("تی‌شرت • رنگ: قرمز، سایز: L");
  });

  it("returns the bare parent name when there are no attributes", () => {
    expect(wooVariationDisplayName("تی‌شرت", [])).toBe("تی‌شرت");
    expect(wooVariationDisplayName("تی‌شرت", undefined)).toBe("تی‌شرت");
  });

  it("skips an attribute with a missing half rather than printing a dangling colon", () => {
    expect(wooVariationDisplayName("تی‌شرت", [{ name: "رنگ", option: "" }])).toBe("تی‌شرت");
  });
});

describe("wooVariationAttributes", () => {
  it("reads the normalised shape the plugin sends", () => {
    expect(wooVariationAttributes({ variation_attributes: [{ name: "رنگ", option: "قرمز" }] })).toEqual([
      { name: "رنگ", option: "قرمز" },
    ]);
  });

  it("reads a variation resource's attributes array", () => {
    expect(wooVariationAttributes({ attributes: [{ name: "رنگ", option: "آبی" }] })).toEqual([
      { name: "رنگ", option: "آبی" },
    ]);
  });

  it("reads attribute_* meta_data, the shape a raw order line carries", () => {
    expect(
      wooVariationAttributes({
        meta_data: [
          { key: "attribute_pa_colour", value: "قرمز" },
          { key: "attribute_size", value: "L" },
          { key: "_reduced_stock", value: "2" },
        ],
      }),
    ).toEqual([
      { name: "pa_colour", option: "قرمز" },
      { name: "size", option: "L" },
    ]);
  });

  it("strips the attribute_ prefix from a raw key", () => {
    expect(wooAttributeSlug("attribute_pa_colour")).toBe("pa_colour");
    expect(wooAttributeSlug("colour")).toBe("colour");
  });
});

describe("taxonomies", () => {
  it("labels the built-ins in Persian and derives a label for an attribute", () => {
    expect(wooTaxonomyLabel("product_cat")).toBe("دسته‌بندی‌ها");
    expect(wooTaxonomyLabel("pa_colour")).toBe("ویژگی: colour");
    expect(wooTaxonomyLabel("brand")).toBe("brand");
  });

  it("labels an attribute the same way it badges one, whatever the slug's case", () => {
    // isWooAttributeTaxonomy is case-insensitive; the label used to be
    // case-sensitive, so `PA_Colour` was badged «ویژگی» and labelled with its
    // raw slug in the same row.
    expect(wooTaxonomyLabel("PA_Colour")).toBe("ویژگی: Colour");
  });

  it("humanises a hyphenated attribute slug instead of showing the URL fragment", () => {
    expect(wooTaxonomyLabel("pa_shoe-size")).toBe("ویژگی: shoe size");
  });

  it("recognises an attribute taxonomy by its pa_ prefix", () => {
    expect(isWooAttributeTaxonomy("pa_colour")).toBe(true);
    expect(isWooAttributeTaxonomy("product_cat")).toBe(false);
  });

  it("renders a term's path through its tree", () => {
    const byId = new Map([
      ["1", { remoteId: "1", parentRemoteId: null, name: "پوشاک" }],
      ["2", { remoteId: "2", parentRemoteId: "1", name: "تی‌شرت" }],
      ["3", { remoteId: "3", parentRemoteId: "2", name: "یقه‌دار" }],
    ]);
    expect(wooTermPath(byId.get("3")!, byId)).toBe("پوشاک › تی‌شرت › یقه‌دار");
  });

  it("terminates instead of hanging when a store has made a term its own ancestor", () => {
    // A bad import can do this. The guarantee worth testing is that it
    // returns — a term whose parent chain loops would otherwise spin forever
    // while rendering the taxonomy browser.
    const byId = new Map([
      ["1", { remoteId: "1", parentRemoteId: "2", name: "الف" }],
      ["2", { remoteId: "2", parentRemoteId: "1", name: "ب" }],
    ]);
    const path = wooTermPath(byId.get("1")!, byId);
    expect(path).toContain("الف");
    expect(path).toContain("ب");
    expect(path.split("›")).toHaveLength(2);
  });

  it("sorts a flat list into tree order — parents first, siblings by menu_order", () => {
    const terms = [
      { remoteId: "3", parentRemoteId: "1", name: "یقه‌دار", menuOrder: 1 },
      { remoteId: "2", parentRemoteId: "1", name: "آستین‌کوتاه", menuOrder: 0 },
      { remoteId: "1", parentRemoteId: null, name: "تی‌شرت", menuOrder: 0 },
    ];
    expect(sortWooTerms(terms).map((t) => t.remoteId)).toEqual(["1", "2", "3"]);
  });

  it("breaks a menu_order tie by name", () => {
    const terms = [
      { remoteId: "2", parentRemoteId: null, name: "ب", menuOrder: 0 },
      { remoteId: "1", parentRemoteId: null, name: "الف", menuOrder: 0 },
    ];
    expect(sortWooTerms(terms).map((t) => t.remoteId)).toEqual(["1", "2"]);
  });

  it("keeps each parent immediately followed by its own subtree", () => {
    // The bug this replaces: sorting purely by depth put both roots first and
    // both children after them, so «کتانی» was drawn under «پوشاک» with a
    // tree marker that claimed a parent it does not have.
    const terms = [
      { remoteId: "20", parentRemoteId: "2", name: "کتانی", menuOrder: 0 },
      { remoteId: "1", parentRemoteId: null, name: "پوشاک", menuOrder: 0 },
      { remoteId: "10", parentRemoteId: "1", name: "تی‌شرت", menuOrder: 0 },
      { remoteId: "2", parentRemoteId: null, name: "کفش", menuOrder: 1 },
      { remoteId: "100", parentRemoteId: "10", name: "یقه‌دار", menuOrder: 0 },
    ];
    expect(sortWooTerms(terms).map((t) => t.remoteId)).toEqual(["1", "10", "100", "2", "20"]);
  });

  it("treats a term whose parent is missing from the list as a root, and keeps it", () => {
    const terms = [
      { remoteId: "5", parentRemoteId: "999", name: "یتیم", menuOrder: 0 },
      { remoteId: "1", parentRemoteId: null, name: "الف", menuOrder: 0 },
    ];
    expect(sortWooTerms(terms).map((t) => t.remoteId)).toEqual(["1", "5"]);
  });

  it("returns every term even when the store has built a parent cycle", () => {
    // A bad import can do this; losing rows off the screen would be worse
    // than drawing them at the wrong level.
    const terms = [
      { remoteId: "1", parentRemoteId: "2", name: "الف", menuOrder: 0 },
      { remoteId: "2", parentRemoteId: "1", name: "ب", menuOrder: 0 },
      { remoteId: "3", parentRemoteId: null, name: "ج", menuOrder: 0 },
    ];
    const sorted = sortWooTerms(terms);
    expect(sorted).toHaveLength(3);
    expect(sorted.map((t) => t.remoteId).sort()).toEqual(["1", "2", "3"]);
  });

  it("does not let a term that claims itself as its parent disappear", () => {
    const terms = [{ remoteId: "1", parentRemoteId: "1", name: "الف", menuOrder: 0 }];
    expect(sortWooTerms(terms).map((t) => t.remoteId)).toEqual(["1"]);
  });
});

describe("wooTermDepth", () => {
  const byId = new Map([
    ["1", { remoteId: "1", parentRemoteId: null, name: "پوشاک" }],
    ["2", { remoteId: "2", parentRemoteId: "1", name: "تی‌شرت" }],
    ["3", { remoteId: "3", parentRemoteId: "2", name: "یقه‌دار" }],
    ["9", { remoteId: "9", parentRemoteId: "404", name: "یتیم" }],
  ]);

  it("counts levels from the root, so a grandchild indents twice", () => {
    expect(wooTermDepth(byId.get("1")!, byId)).toBe(0);
    expect(wooTermDepth(byId.get("2")!, byId)).toBe(1);
    expect(wooTermDepth(byId.get("3")!, byId)).toBe(2);
  });

  it("treats an unknown parent as a root rather than as depth 1", () => {
    expect(wooTermDepth(byId.get("9")!, byId)).toBe(0);
  });

  it("terminates on a cycle", () => {
    const looped = new Map([
      ["1", { remoteId: "1", parentRemoteId: "2", name: "الف" }],
      ["2", { remoteId: "2", parentRemoteId: "1", name: "ب" }],
    ]);
    expect(wooTermDepth(looped.get("1")!, looped)).toBe(1);
  });
});

describe("planWooCatalogueWrite", () => {
  it("writes containers before the variations that need them", () => {
    const parent = product({ id: 5, type: "variable" });
    const child = product({ id: 6, type: "variation", parent_id: 5 });
    const plan = planWooCatalogueWrite([child, parent]);
    expect(plan.containers.map((p) => p.id)).toEqual([5]);
    expect(plan.sellables.map((p) => p.id)).toEqual([6]);
  });

  it("writes a variation whose parent is not in this batch straight away", () => {
    // Its parent had to have been written by an earlier page, or the mapping
    // lookup fails and the product is retried next run — the pre-Phase-38
    // behaviour, kept only for the case where it is genuinely true.
    const child = product({ id: 6, type: "variation", parent_id: 99 });
    const plan = planWooCatalogueWrite([child]);
    expect(plan.containers.map((p) => p.id)).toEqual([6]);
    expect(plan.sellables).toHaveLength(0);
  });

  it("defers a subscription_variation behind its variable-subscription parent, same as the core spellings", () => {
    // WooCommerce Subscriptions renames both sides of the parent/child pair;
    // the ordering rule must follow the alias table, not the literal strings.
    const parent = product({ id: 20, type: "variable-subscription" });
    const child = product({ id: 21, type: "subscription_variation", parent_id: 20 });
    const plan = planWooCatalogueWrite([child, parent]);
    expect(plan.containers.map((p) => p.id)).toEqual([20]);
    expect(plan.sellables.map((p) => p.id)).toEqual([21]);
    expect(plan.skipped).toHaveLength(0);
  });

  it("keeps simple products in the first pass alongside the containers", () => {
    const plan = planWooCatalogueWrite([
      product({ id: 1, type: "simple" }),
      product({ id: 5, type: "variable" }),
      product({ id: 6, type: "variation", parent_id: 5 }),
    ]);
    expect(plan.containers.map((p) => p.id)).toEqual([5, 1]);
    expect(plan.sellables.map((p) => p.id)).toEqual([6]);
  });

  it("treats a grouped product as a container but does not re-parent its members", () => {
    const group = product({ id: 8, type: "grouped", grouped_products: [1, 2] });
    const plan = planWooCatalogueWrite([group, product({ id: 1, type: "simple" })]);
    expect(plan.containers.map((p) => p.id)).toEqual([8, 1]);
    expect(plan.sellables).toHaveLength(0);
  });

  it("skips nothing, because every type now has an answer", () => {
    const plan = planWooCatalogueWrite([
      product({ id: 1, type: "simple" }),
      product({ id: 2, type: "external" }),
      product({ id: 3, type: "bundle" }),
      product({ id: 4, type: "mystery-extension-type" }),
      product({ id: 5, type: "variable" }),
      product({ id: 6, type: "variation", parent_id: 5 }),
      product({ id: 7, type: "grouped" }),
    ]);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.containers.length + plan.sellables.length).toBe(7);
  });
});

describe("wooUpdatePath", () => {
  it("sends a variation's update to the nested endpoint", () => {
    // products/{id} with a variation id is a 404. The old outbox retried it
    // six times and dead-lettered, which is why stock pushes to variations
    // never landed.
    expect(wooUpdatePath("42", "10")).toBe("products/10/variations/42");
  });

  it("sends a plain product's update to the flat endpoint", () => {
    expect(wooUpdatePath("10", null)).toBe("products/10");
    expect(wooUpdatePath("10")).toBe("products/10");
  });

  it("routes every product family the way its shape demands (issue #943, item 6)", () => {
    // Bundles, externals, composites and subscriptions are top-level Woo
    // products: `products/{id}`, never the variations endpoint — a bundle
    // "child" is an ordinary product Woo references, not a variation.
    for (const flat of ["simple", "bundle", "yith_bundle", "composite", "external", "affiliate", "subscription", "simple_subscription", "grouped", "variable"]) {
      // None of these is a variation, so none may take the nested endpoint.
      expect(wooProductShape(flat).family).not.toBe("variation");
      // The writer passes a parent only when the mapping recorded one; these
      // families never record a remoteParentId, so the path stays flat.
      expect(wooUpdatePath("7", null)).toBe("products/7");
    }
    // Both variation spellings — core `variation` and WooCommerce
    // Subscriptions' `subscription_variation` — take the nested endpoint.
    for (const nested of ["variation", "subscription_variation"]) {
      expect(wooProductShape(nested).family).toBe("variation");
      expect(wooUpdatePath("42", "10")).toBe("products/10/variations/42");
    }
  });

  it("never routes a variation without its parent to the flat endpoint", () => {
    // `products/{variationId}` is a 404 in WooCommerce; the drain falls back
    // to the mapping's metadata before accepting an empty parent, so an
    // update to a parentless variation id must never LOOK flat here.
    expect(wooUpdatePath("42", undefined)).toBe("products/42");
    expect(wooUpdatePath("42", "")).toBe("products/42");
  });
});

describe("the SQL type-string lists (issue #943, item 1)", () => {
  // The catalogue page reads shape rules in SQL, and SQL cannot call
  // wooProductShape — so the rules cross as string lists derived from the
  // same TYPE_ALIASES/SHAPES tables. These tests pin the derivation.
  it("names exactly the aliases of each shape, lower-cased and sorted", () => {
    expect(NON_SELLABLE_WOO_TYPE_STRINGS).toEqual(["grouped", "variable", "variable-subscription"]);
    expect(UNTRACKED_WOO_TYPE_STRINGS).toEqual(["affiliate", "external", "grouped", "variable", "variable-subscription"]);
    expect(VARIATION_WOO_TYPE_STRINGS).toEqual(["subscription_variation", "variation"]);
  });

  it("agrees with wooProductShape for every alias a store can send", () => {
    const aliases = [
      "simple", "variable", "variation", "grouped", "external", "affiliate",
      "bundle", "yith_bundle", "composite", "subscription",
      "variable-subscription", "subscription_variation", "simple_subscription",
    ];
    for (const alias of aliases) {
      const shape = wooProductShape(alias);
      expect(NON_SELLABLE_WOO_TYPE_STRINGS.includes(alias)).toBe(!shape.sellable);
      expect(UNTRACKED_WOO_TYPE_STRINGS.includes(alias)).toBe(!shape.stockTracked);
      expect(VARIATION_WOO_TYPE_STRINGS.includes(alias)).toBe(shape.family === "variation");
    }
  });

  it("leaves unknown types out of every list — unknown means sellable and tracked, so an allowlist would drop real products", () => {
    expect(NON_SELLABLE_WOO_TYPE_STRINGS.includes("woosb")).toBe(false);
    expect(UNTRACKED_WOO_TYPE_STRINGS.includes("woosb")).toBe(false);
    expect(VARIATION_WOO_TYPE_STRINGS.includes("woosb")).toBe(false);
  });
});

describe("shouldImportWooOrder", () => {
  it("imports the paid states — the ones where money has actually moved", () => {
    expect(shouldImportWooOrder("processing")).toBe(true);
    expect(shouldImportWooOrder("completed")).toBe(true);
    // A refunded order *was* paid; its refund arrives as its own event and
    // reverses it, so it must be recorded as a sale first.
    expect(shouldImportWooOrder("refunded")).toBe(true);
  });

  it("does not import carts and abandoned checkouts as completed sales", () => {
    // Each of these used to be recorded as a completed, paid order with a
    // revenue journal entry — a pending BACS transfer was revenue on the
    // day the shopper clicked checkout.
    expect(shouldImportWooOrder("pending")).toBe(false);
    expect(shouldImportWooOrder("on-hold")).toBe(false);
    expect(shouldImportWooOrder("cancelled")).toBe(false);
    expect(shouldImportWooOrder("failed")).toBe(false);
    expect(shouldImportWooOrder("draft")).toBe(false);
    expect(shouldImportWooOrder("checkout-draft")).toBe(false);
    expect(shouldImportWooOrder("trash")).toBe(false);
  });

  it("imports a status an extension added rather than dropping the sale", () => {
    // "shipped", "packing", "wc-assembly"… A state this app has never heard
    // of is post-payment in practice, and the rule is that revenue is never
    // silently missed.
    expect(shouldImportWooOrder("shipped")).toBe(true);
    expect(shouldImportWooOrder(undefined)).toBe(true);
  });

  it("is case- and whitespace-tolerant", () => {
    expect(shouldImportWooOrder("Pending")).toBe(false);
    expect(shouldImportWooOrder(" Processing ")).toBe(true);
  });
});

describe("formatWooVariationAttribute", () => {
  it("renders «name: value» when both halves are present", () => {
    expect(formatWooVariationAttribute({ name: "رنگ", option: "قرمز" })).toBe("رنگ: قرمز");
  });

  it("trims whitespace on each half before joining", () => {
    expect(formatWooVariationAttribute({ name: "  Size ", option: " L " })).toBe("Size: L");
  });

  it("is empty when either half is missing, so a bare «رنگ» never dangles off a name", () => {
    // A name with no value reads like a truncated string, not a variation.
    expect(formatWooVariationAttribute({ name: "رنگ", option: "" })).toBe("");
    expect(formatWooVariationAttribute({ name: "", option: "قرمز" })).toBe("");
    expect(formatWooVariationAttribute({ name: "  ", option: "  " })).toBe("");
    expect(
      formatWooVariationAttribute({ name: undefined as never, option: undefined as never }),
    ).toBe("");
  });
});

describe("wooProductRemoteIds", () => {
  it("is the product's own id as a string — the key the mapping is stored under", () => {
    expect(wooProductRemoteIds({ id: 42 } as never)).toEqual(["42"]);
  });

  it("keeps a mapping for a container too, so an unmapped variation line can fall back to it", () => {
    expect(wooProductRemoteIds({ id: 10, type: "variable" } as never)).toEqual(["10"]);
    expect(wooProductRemoteIds({ id: 5, type: "grouped" } as never)).toEqual(["5"]);
  });
});

// ---------------------------------------------------------------------------
// Catalogue listing rules (issue #943)
// ---------------------------------------------------------------------------

function listRow(overrides: Partial<CatalogueListRow> = {}): CatalogueListRow {
  return {
    remoteId: "1",
    name: "تی‌شرت",
    sku: null,
    wooType: "simple",
    sellable: true,
    quantity: 5,
    categories: [],
    attributes: [],
    ...overrides,
  };
}

describe("catalogueRowMatches", () => {
  const row = listRow({
    remoteId: "9",
    name: "کفش ورزشی",
    sku: "SHOE-9",
    wooType: "variation",
    categories: ["پوشاک"],
    attributes: ["رنگ: قرمز"],
  });

  it("searches name, SKU, type, category and attributes — one predicate, both sides", () => {
    // The UI used to re-filter the server's page with a predicate that
    // excluded `wooType`; the API and the panel must share this one rule.
    expect(catalogueRowMatches(row, { search: "کفش" })).toBe(true);
    expect(catalogueRowMatches(row, { search: "shoe-9" })).toBe(true);
    expect(catalogueRowMatches(row, { search: "VARIATION" })).toBe(true);
    expect(catalogueRowMatches(row, { search: "پوشاک" })).toBe(true);
    expect(catalogueRowMatches(row, { search: "قرمز" })).toBe(true);
    expect(catalogueRowMatches(row, { search: "کیف" })).toBe(false);
  });

  it("filters by the exact classified type", () => {
    expect(catalogueRowMatches(row, { type: "variation" })).toBe(true);
    expect(catalogueRowMatches(row, { type: "simple" })).toBe(false);
  });

  it("treats a blank filter as no filter", () => {
    expect(catalogueRowMatches(row, { search: "   ", type: "" })).toBe(true);
  });
});

describe("catalogueTypeFacets", () => {
  it("lists every type in the WHOLE catalogue, not just the visible page", () => {
    // The old UI derived its type dropdown from `products.map(...)` — the
    // current page — so a type that existed only on page 2 was unselectable.
    const rows = [
      listRow({ remoteId: "1", wooType: "simple" }),
      listRow({ remoteId: "2", wooType: "variation" }),
      listRow({ remoteId: "3", wooType: "simple" }),
      listRow({ remoteId: "4", wooType: "grouped" }),
    ];
    expect(catalogueTypeFacets(rows)).toEqual(["grouped", "simple", "variation"]);
  });
});

describe("catalogueSummary", () => {
  it("counts the axes the panel chips show", () => {
    const rows = [
      listRow({ remoteId: "1", quantity: 0, categories: ["پوشاک"] }),
      listRow({ remoteId: "2", wooType: "variable", sellable: false, quantity: null }),
      listRow({ remoteId: "3", wooType: "variation", quantity: 2 }),
    ];
    expect(catalogueSummary(rows)).toEqual({
      total: 3,
      sellable: 2,
      containers: 1,
      variations: 1,
      outOfStock: 1,
      uncategorised: 2,
    });
  });

  it("never counts a null quantity as out of stock — untracked is not zero", () => {
    expect(catalogueSummary([listRow({ quantity: null })]).outOfStock).toBe(0);
    expect(catalogueSummary([listRow({ quantity: 0 })]).outOfStock).toBe(1);
  });
});

describe("sortCatalogueRows + paginateCatalogueRows", () => {
  it("is deterministic: name first, remote id as the tie-breaker", () => {
    const rows = [
      listRow({ remoteId: "3", name: "ب" }),
      listRow({ remoteId: "2", name: "آ" }),
      listRow({ remoteId: "1", name: "ب" }),
    ];
    expect(sortCatalogueRows(rows).map((r) => r.remoteId)).toEqual(["2", "1", "3"]);
  });

  it("pages a 1200-row catalogue with no duplicate and no missing row", () => {
    // The regression the missing ORDER BY produced: an unstable slice could
    // repeat or drop a row between two reads of one unchanged catalogue.
    const rows = Array.from({ length: 1200 }, (_, i) =>
      listRow({ remoteId: String(i + 1), name: `محصول ${((i * 37) % 1200) + 1}` }),
    );
    const ordered = sortCatalogueRows(rows);
    const seen = new Set<string>();
    const pageSize = 25;
    const pages = Math.ceil(ordered.length / pageSize);
    for (let page = 1; page <= pages; page += 1) {
      const slice = paginateCatalogueRows(ordered, page, pageSize);
      expect(slice.total).toBe(1200);
      expect(slice.totalPages).toBe(pages);
      for (const row of slice.rows) {
        expect(seen.has(row.remoteId), `duplicate row ${row.remoteId} on page ${page}`).toBe(false);
        seen.add(row.remoteId);
      }
    }
    expect(seen.size).toBe(1200);
  });

  it("clamps a hostile page request instead of trusting it", () => {
    const rows = Array.from({ length: 30 }, (_, i) => listRow({ remoteId: String(i + 1), name: `p${i}` }));
    expect(paginateCatalogueRows(rows, 0, 25).page).toBe(1);
    expect(paginateCatalogueRows(rows, 2, 5).pageSize).toBe(10);
    expect(paginateCatalogueRows(rows, 1, 500).pageSize).toBe(100);
    expect(paginateCatalogueRows(rows, 99, 25).rows).toEqual([]);
    expect(paginateCatalogueRows([], 1, 25).totalPages).toBe(1);
  });
});

describe("filterCatalogueRows", () => {
  it("applies the shared predicate over the whole list", () => {
    const rows = [
      listRow({ remoteId: "1", name: "چای" }),
      listRow({ remoteId: "2", name: "قهوه", wooType: "variable", sellable: false }),
    ];
    expect(filterCatalogueRows(rows, { search: "چای" }).map((r) => r.remoteId)).toEqual(["1"]);
    expect(filterCatalogueRows(rows, { type: "variable" }).map((r) => r.remoteId)).toEqual(["2"]);
    expect(filterCatalogueRows(rows, {}).length).toBe(2);
  });
});
