import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { acknowledgeTaxonomyEnsure, applyTaxonomyEnsure, buildMappedWooAttributes, validAttributeEnsurePayload, type AttributeEnsurePayload } from "./product-attribute-mappings-service";
import type { ConnectionRow } from "./connections-service";
const mocks = vi.hoisted(() => ({ client: { listAttributes: vi.fn(), createAttribute: vi.fn(), listAttributeTerms: vi.fn(), createAttributeTerm: vi.fn() } }));
vi.mock("../db", () => ({ query: vi.fn(), withTenantTransaction: vi.fn(async (_id, fn) => fn()) }));
vi.mock("./connections-service", () => ({ wooClientFor: () => mocks.client }));
vi.mock("./plugin-job-guard", () => ({ assertPluginJobSupported: vi.fn() }));
const payload: AttributeEnsurePayload = {
  definitionId: "11111111-1111-4111-8111-111111111111", definitionVersion: 1,
  reviewedBy: "22222222-2222-4222-8222-222222222222", name: "رنگ", slug: "color",
  terms: [{ local: "قرمز", name: "Red", slug: "red" }],
};
const connection = { id: "store", business_id: "business", location_id: "branch" } as ConnectionRow;
describe("reviewed Woo attribute identities", () => {
  beforeEach(() => vi.resetAllMocks());
  it("reuses remote slugs on retries without creating duplicate attributes or terms", async () => {
    mocks.client.listAttributes.mockResolvedValue([{ id: 41, slug: "pa_color" }]);
    mocks.client.listAttributeTerms.mockResolvedValue([{ id: 87, name: "Red", slug: "red" }]);
    expect(await applyTaxonomyEnsure(connection, payload)).toEqual({ attributeId: 41, taxonomy: "pa_color", terms: { "قرمز": { id: 87, name: "Red", slug: "red" } } });
    expect(mocks.client.createAttribute).not.toHaveBeenCalled();
    expect(mocks.client.createAttributeTerm).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("creates missing remote identities but leaves local mapping untouched until acknowledgement", async () => {
    mocks.client.listAttributes.mockResolvedValue([]);
    mocks.client.createAttribute.mockResolvedValue({ id: 41, slug: "pa_color" });
    mocks.client.listAttributeTerms.mockResolvedValue([]);
    mocks.client.createAttributeTerm.mockResolvedValue({ id: 87, name: "Red", slug: "red" });
    const result = await applyTaxonomyEnsure(connection, payload);
    expect(query).not.toHaveBeenCalled();
    vi.mocked(query).mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    await acknowledgeTaxonomyEnsure("business", "store", payload, result);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["business", "store", payload.definitionId, 41, "pa_color", JSON.stringify(result.terms), payload.reviewedBy, 1]);
  });
  it("rejects malformed mappings and a store acknowledgement with a different term slug", async () => {
    expect(validAttributeEnsurePayload({ ...payload, slug: "pa/color" })).toBe(false);
    expect(validAttributeEnsurePayload({ ...payload, terms: [...payload.terms, payload.terms[0]] })).toBe(false);
    await expect(acknowledgeTaxonomyEnsure("business", "store", payload, { attributeId: 41, taxonomy: "pa_color", terms: { "قرمز": { id: 87, slug: "blue", name: "Blue" } } })).rejects.toThrow("invalid_attribute_ack");
    expect(query).not.toHaveBeenCalled();
  });
  it("blocks variation publication until every local snapshot has a reviewed remote mapping", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ kind: "variant_child", location_id: "branch" }] } as never)
      .mockResolvedValueOnce({ rows: [{ definition_id: payload.definitionId, value: "قرمز", remote_attribute_id: null, terms: null }] } as never);
    await expect(buildMappedWooAttributes("business", connection, "child")).rejects.toThrow("attribute_mapping_required");
  });
  it("uses Woo's attribute ID and term name in variation assignments, never a local UUID or term ID", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ kind: "variant_child", location_id: "branch" }] } as never)
      .mockResolvedValueOnce({ rows: [{ definition_id: payload.definitionId, value: "قرمز", remote_attribute_id: 41, terms: { "قرمز": { id: 87, name: "Red", slug: "red" } } }] } as never);
    expect(await buildMappedWooAttributes("business", connection, "child")).toEqual([{ id: 41, option: "Red" }]);
  });
});
