import { describe, expect, it, vi } from "vitest";
import type { WooCommerceClient } from "./woocommerce-client";
import { cataloguePublicationTaxonomies, catalogueTermSlug } from "./catalogue-publication-taxonomies";

function fixture() {
  const category = { id: 5, name: "Collection", slug: "collection" };
  const term = { id: 7, name: "Silver", slug: "silver" };
  const listAttributeTerms = vi.fn().mockResolvedValue([term]);
  const client = {
    listCategories: vi.fn().mockResolvedValue([category]),
    listAttributes: vi.fn().mockResolvedValue([{ id: 6, name: "Dial color", slug: "pa_dial-color" }]),
    listAttributeTerms,
    createAttribute: vi.fn(), createAttributeTerm: vi.fn(), createCategory: vi.fn(),
  };
  const spec = { attributeId: 6, field: "face", value: "Silver", slug: "dial-color", term };
  return { client: client as unknown as WooCommerceClient, spec, term, category, listAttributeTerms };
}

describe("reviewed catalogue taxonomies", () => {
  it("reuses the exact approved category and global attribute IDs", async () => {
    const { client, spec, category } = fixture();
    const body = {};
    const ack = await cataloguePublicationTaxonomies(client, body, { __catalogueAttributes: [spec], __catalogueCategory: category });
    expect(body).toEqual({ categories: [{ id: 5 }], attributes: [{ id: 6, visible: true, variation: false, options: ["Silver"] }] });
    expect(ack.terms[0]).toMatchObject({ attributeId: 6, id: 7, taxonomy: "pa_dial-color" });
    expect(client.createAttributeTerm).not.toHaveBeenCalled();
    expect(client.createCategory).not.toHaveBeenCalled();
  });

  it("requires approval for missing terms and recovers the same term after a lost ACK", async () => {
    const { client, spec, listAttributeTerms } = fixture();
    const missing = { ...spec, value: "Blue", term: null };
    await expect(cataloguePublicationTaxonomies(client, {}, { __catalogueAttributes: [missing] })).rejects.toThrow("attribute_term_changed");
    expect(client.createAttributeTerm).not.toHaveBeenCalled();
    const created = { id: 9, name: "Blue", slug: catalogueTermSlug("Blue") };
    vi.mocked(client.createAttributeTerm).mockResolvedValue(created as never);
    const approved = { __catalogueAttributes: [missing], __catalogueAllowCreate: true };
    await expect(cataloguePublicationTaxonomies(client, {}, approved)).resolves.toMatchObject({ terms: [{ id: 9 }] });
    listAttributeTerms.mockResolvedValue([created]);
    await expect(cataloguePublicationTaxonomies(client, {}, approved)).resolves.toMatchObject({ terms: [{ id: 9 }] });
    expect(client.createAttributeTerm).toHaveBeenCalledTimes(1);
  });
});
