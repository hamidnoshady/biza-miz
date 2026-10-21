import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #911 — the sellable rule the website catalogue shows.
 *
 * `listWebsiteCatalog` selected F&B products on `m.is_active` alone, so
 * retiring a *category* left its items published: the website kept selling
 * something the till no longer offers, because the POS index has always
 * dropped an item whose category is inactive (and an item with no category at
 * all). One rule now, the same one the till applies.
 *
 * The exclusion itself is proven against a real database in
 * `integration/website-catalog-sellable.integration.test.ts`. What is pinned
 * here — where there is no database — is the predicate that produces it and
 * the row mapping the screen reads.
 */
import * as db from "../db";
import { listWebsiteCatalog } from "./catalog-service";

vi.mock("../db", () => ({ query: vi.fn() }));

const BUSINESS = "biz-1";
const LOCATION = "loc-1";

let sql = "";
let params: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query).mockImplementation(async (text: string, values?: unknown[]) => {
    sql = text;
    params = values ?? [];
    return { rows: [] } as never;
  });
});

async function call() {
  await listWebsiteCatalog(BUSINESS, LOCATION);
  return sql;
}

describe("listWebsiteCatalog — the sellable predicate", () => {
  it("lists an F&B product only when the item AND its category are active", async () => {
    const statement = await call();
    // The item's own switch …
    expect(statement).toMatch(/m\.is_active/);
    // … and the category it sits in: a JOIN on the category, filtered on the
    // category's switch. An item with no category is not listed either —
    // exactly as it is absent from every POS category.
    expect(statement).toMatch(/JOIN\s+menu_categories\s+c\s+ON\s+c\.id\s*=\s*m\.category_id/i);
    expect(statement).toMatch(/c\.is_active/);
  });

  it("keeps the retail rule it already had", async () => {
    const statement = await call();
    expect(statement).toMatch(/i\.is_active/);
    expect(statement).toMatch(/i\.kind\s*<>\s*'variant_parent'/);
  });

  it("scopes both halves to one business and one branch", async () => {
    await call();
    expect(params[0]).toBe(BUSINESS);
    expect(params[1]).toBe(LOCATION);
    // The branch filter appears once per product model — nothing is read
    // across branches.
    expect(sql.match(/location_id\s*=\s*\$2/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("listWebsiteCatalog — the row it hands the screen", () => {
  it("maps a stored row to the wire shape", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        {
          local_kind: "menu_item",
          local_id: "item-1",
          name: "لاته",
          sku: "LAT-01",
          price: "120000",
          sync_enabled: true,
          remote_id: "9911",
          last_pushed_at: null,
          last_pushed_price_rial: "120000",
          last_pushed_stock: null,
        },
      ],
    } as never);

    const rows = await listWebsiteCatalog(BUSINESS, LOCATION);
    expect(rows).toEqual([
      {
        localKind: "menu_item",
        localId: "item-1",
        name: "لاته",
        sku: "LAT-01",
        priceRial: 120_000,
        syncEnabled: true,
        remoteId: "9911",
        lastPushedAt: null,
        lastPushedPriceRial: 120_000,
        lastPushedStock: null,
      },
    ]);
  });

  it("reads an unpriced or unmarked product as null/false rather than 0", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        {
          local_kind: "item",
          local_id: "item-2",
          name: "لیوان",
          sku: null,
          price: null,
          sync_enabled: null,
          remote_id: null,
          last_pushed_at: null,
          last_pushed_price_rial: null,
          last_pushed_stock: null,
        },
      ],
    } as never);

    const [row] = await listWebsiteCatalog(BUSINESS, LOCATION);
    expect(row.priceRial).toBeNull();
    expect(row.syncEnabled).toBe(false);
    expect(row.remoteId).toBeNull();
  });
});
