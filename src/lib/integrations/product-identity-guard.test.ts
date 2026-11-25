import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  assertNoAmbiguousLocalIdentity,
  findLocalSkuMatches,
  isAmbiguousLocalMatch,
  PRODUCT_IDENTITY_REVIEW_REQUIRED,
  type LocalSkuMatch,
} from "./product-identity-guard";

function match(overrides: Partial<LocalSkuMatch> = {}): LocalSkuMatch {
  return {
    itemId: "item-1",
    name: "کرم مرطوب‌کننده",
    kind: "simple",
    parentItemId: null,
    mappings: [],
    ...overrides,
  };
}

function client(responses: unknown[][]): PoolClient {
  const query = vi.fn(async (sql: string) => {
    // The guard takes the branch+SKU advisory lock before it reads; that query
    // has no rows of its own.
    if (String(sql).includes("pg_advisory_xact_lock")) return { rows: [] };
    return { rows: responses.shift() ?? [] };
  });
  return { query } as unknown as PoolClient;
}

const input = {
  businessId: "biz-1",
  locationId: "loc-1",
  connectionId: "conn-new",
  sku: " zza05023 ",
};

describe("isAmbiguousLocalMatch", () => {
  it("treats an unmapped local row as ambiguous — the reimport shape", () => {
    expect(isAmbiguousLocalMatch(match(), "conn-new")).toBe(true);
  });

  it("allows a row owned only by the creating connection", () => {
    expect(
      isAmbiguousLocalMatch(
        match({ mappings: [{ connectionId: "conn-new", entityType: "product", remoteId: "9" }] }),
        "conn-new",
      ),
    ).toBe(false);
  });

  it("treats a row mapped through another connection as ambiguous — the reconnect shape", () => {
    expect(
      isAmbiguousLocalMatch(
        match({ mappings: [{ connectionId: "conn-old", entityType: "product", remoteId: "9" }] }),
        "conn-new",
      ),
    ).toBe(true);
  });

  it("treats a row mapped through this and another connection as ambiguous", () => {
    expect(
      isAmbiguousLocalMatch(
        match({
          mappings: [
            { connectionId: "conn-new", entityType: "product", remoteId: "9" },
            { connectionId: "conn-old", entityType: "product", remoteId: "9" },
          ],
        }),
        "conn-new",
      ),
    ).toBe(true);
  });
});

describe("findLocalSkuMatches / assertNoAmbiguousLocalIdentity", () => {
  it("returns nothing for an empty SKU without querying", async () => {
    const query = vi.fn();
    const fake = { query } as unknown as PoolClient;
    await expect(findLocalSkuMatches(fake, { ...input, sku: "   " })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("joins each matching row to its own product mappings", async () => {
    const fake = client([
      [
        { item_id: "item-1", name: "کرم", kind: "simple", parent_item_id: null },
        { item_id: "item-2", name: "کرم", kind: "simple", parent_item_id: null },
      ],
      [{ local_id: "item-2", connection_id: "conn-old", entity_type: "product", remote_id: "9" }],
    ]);
    const matches = await findLocalSkuMatches(fake, input);
    expect(matches).toEqual([
      { itemId: "item-1", name: "کرم", kind: "simple", parentItemId: null, mappings: [] },
      {
        itemId: "item-2",
        name: "کرم",
        kind: "simple",
        parentItemId: null,
        mappings: [{ connectionId: "conn-old", entityType: "product", remoteId: "9" }],
      },
    ]);
  });

  it("throws the sentinel for an ambiguous row and stays silent otherwise", async () => {
    await expect(
      assertNoAmbiguousLocalIdentity(
        client([
          [{ item_id: "item-1", name: "کرم", kind: "simple", parent_item_id: null }],
          [],
        ]),
        input,
      ),
    ).rejects.toThrow(PRODUCT_IDENTITY_REVIEW_REQUIRED);

    await expect(
      assertNoAmbiguousLocalIdentity(
        client([
          [{ item_id: "item-2", name: "کرم", kind: "simple", parent_item_id: null }],
          [{ local_id: "item-2", connection_id: "conn-new", entity_type: "product", remote_id: "9" }],
        ]),
        input,
      ),
    ).resolves.toBeUndefined();
  });
});
