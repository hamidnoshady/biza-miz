import { describe, expect, it, vi } from "vitest";
import { applyCatalogueTaxonomy, catalogueTermSlug } from "./catalogue-publication-taxonomy";
import type { WooCommerceClient } from "./woocommerce-client";

describe("reviewed catalogue taxonomy publication", () => {
  it("creates only approved terms, then reuses stable IDs after a retry", async () => {
    const category = { id: 1, name: "Sport", slug: catalogueTermSlug("Sport") };
    const attribute = { id: 2, name: "case color", slug: "pa_case-color" };
    const term = { id: 3, name: "مشکی", slug: catalogueTermSlug("مشکی") };
    const client = {
      listCategories: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([category]),
      listAttributes: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([attribute]),
      listAttributeTerms: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([term]),
      createCategory: vi.fn().mockResolvedValue(category),
      createAttribute: vi.fn().mockResolvedValue(attribute),
      createAttributeTerm: vi.fn().mockResolvedValue(term),
    };
    const plan = { category: { name: category.name, slug: category.slug },
      attributes: [{ name: attribute.name, slug: "case-color", term: { name: term.name, slug: term.slug } }] };
    const first = await applyCatalogueTaxonomy(client as unknown as WooCommerceClient, plan);
    expect(first.body).toEqual({ categories: [{ id: 1 }], attributes: [{ id: 2, visible: true, variation: false, options: ["مشکی"] }] });
    expect(await applyCatalogueTaxonomy(client as unknown as WooCommerceClient, plan)).toEqual(first);
    expect(client.createCategory).toHaveBeenCalledTimes(1);
    expect(client.createAttribute).toHaveBeenCalledTimes(1);
    expect(client.createAttributeTerm).toHaveBeenCalledTimes(1);
  });

  it("refuses a changed reviewed ID or a slug occupied by an unrelated term", async () => {
    const client = {
      listCategories: vi.fn().mockResolvedValue([{ id: 42, slug: "sports", name: "Outdoor" }]),
      createCategory: vi.fn(),
    };
    await expect(applyCatalogueTaxonomy(client as unknown as WooCommerceClient, {
      category: { id: 99, slug: "sports", name: "Sport" }, attributes: [],
    })).rejects.toThrow("publication_taxonomy_changed");
    await expect(applyCatalogueTaxonomy(client as unknown as WooCommerceClient, {
      category: { slug: "sports", name: "Sport" }, attributes: [],
    })).rejects.toThrow("publication_taxonomy_slug_conflict");
    expect(client.createCategory).not.toHaveBeenCalled();
  });
});
