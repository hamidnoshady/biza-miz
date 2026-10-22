/**
 * The scheduled push path, at the seam issue #943 found broken: a variation's
 * price/stock event used to be queued WITHOUT its parent, and REST mode then
 * sent it to `products/{variation}` — a 404 that dead-lettered every nightly
 * stock push a variable product had. The manual `product_update` resolved the
 * parent; the automatic refresh never did. These tests pin the centralized
 * parent resolution, the legacy-row fallback in the drain, and the rule that
 * a pending manual edit owns its axis until it is delivered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { refreshOutboxForConnection, drainOutbox, acknowledgePushedEvent } from "./outbox-service";
import type { ConnectionRow } from "./connections-service";

const mocks = vi.hoisted(() => ({
  getBusinessIndustry: vi.fn(),
  hasSellableCatalogue: vi.fn(),
  listMappings: vi.fn(),
  setLastPushedPayload: vi.fn(),
  wooClientFor: vi.fn(),
  parentRemoteIdFor: vi.fn(),
  writeIntegrationAudit: vi.fn(),
}));

vi.mock("../db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  closeDatabasePool: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  rlsEffective: vi.fn(),
  assertRlsEffective: vi.fn(),
}));
vi.mock("../industry-guard", () => ({ getBusinessIndustry: mocks.getBusinessIndustry }));
vi.mock("../industries", () => ({ hasSellableCatalogue: mocks.hasSellableCatalogue }));
vi.mock("./connections-service", () => ({ getConnection: vi.fn(), wooClientFor: mocks.wooClientFor }));
vi.mock("./mapping-service", () => ({
  listMappings: mocks.listMappings,
  setLastPushedPayload: mocks.setLastPushedPayload,
}));
// The repo's convention keeps the DB-heavy sync-service out of unit tests;
// `parentRemoteIdFromMeta` is pure, so the mock carries its exact rule rather
// than importing the whole module chain.
vi.mock("./sync-service", () => ({
  parentRemoteIdFor: mocks.parentRemoteIdFor,
  parentRemoteIdFromMeta: (meta: unknown) => {
    const parent = (meta as { remoteParentId?: unknown } | null | undefined)?.remoteParentId;
    return typeof parent === "string" && parent ? parent : null;
  },
}));
vi.mock("./audit", () => ({ writeIntegrationAudit: mocks.writeIntegrationAudit }));

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    business_id: "biz-1",
    location_id: "loc-1",
    provider: "woocommerce",
    link_mode: "rest_api",
    status: "active",
    currency_unit: "toman",
    push_stock: true,
    push_prices: true,
    ...overrides,
  } as ConnectionRow;
}

/** The retail desired-state row: 9 on hand, 1000 Rial on the shelf. */
const LOCAL_STATE = { quantity: "9", unit_price: "1000" };

function stubQueries(options: { manualProductUpdates?: { remote_id: string; payload: Record<string, unknown> }[] } = {}) {
  const inserts: { sql: string; params: unknown[] }[] = [];
  vi.mocked(query).mockImplementation((async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes("INSERT INTO integration_outbox_events")) {
      inserts.push({ sql: text, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("FROM integration_outbox_events")) {
      return { rows: options.manualProductUpdates ?? [] };
    }
    if (text.includes("item_stock")) {
      return { rows: [LOCAL_STATE] };
    }
    return { rows: [] };
  }) as never);
  return inserts;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBusinessIndustry.mockResolvedValue("accessories");
  mocks.hasSellableCatalogue.mockReturnValue(true);
  mocks.parentRemoteIdFor.mockResolvedValue(null);
});

describe("refreshOutboxForConnection — variation routing", () => {
  it("queues a variation's price and stock WITH __parentRemoteId, so REST mode targets the variations path", async () => {
    mocks.listMappings.mockResolvedValue([
      {
        entityType: "product",
        remoteId: "11",
        localId: "local-11",
        // The parent id is recorded on the mapping when the product synced;
        // the scheduled push must read it exactly like the manual enqueue.
        lastPushedPayload: { wooType: "variation", remoteParentId: "10" },
        updatedAt: null,
      },
    ]);
    const inserts = stubQueries();

    await refreshOutboxForConnection(connection());

    const price = inserts.find((i) => i.params[2] === "price");
    const stock = inserts.find((i) => i.params[2] === "stock");
    expect(price).toBeTruthy();
    expect(stock).toBeTruthy();
    expect(JSON.parse(String(price!.params[5]))).toMatchObject({
      regular_price: "100", // 1000 Rial → 100 Toman, the store's unit
      __parentRemoteId: "10",
    });
    expect(JSON.parse(String(stock!.params[5]))).toMatchObject({
      stock_quantity: 9,
      manage_stock: true,
      __parentRemoteId: "10",
    });
  });

  it("queues a simple product without a parent key — the flat path stays flat", async () => {
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "5", localId: "local-5", lastPushedPayload: {}, updatedAt: null },
    ]);
    const inserts = stubQueries();

    await refreshOutboxForConnection(connection());

    const price = inserts.find((i) => i.params[2] === "price");
    expect(price).toBeTruthy();
    expect(JSON.parse(String(price!.params[5]))).not.toHaveProperty("__parentRemoteId");
  });

  it("does not queue an axis a pending manual edit already owns — the human decision wins until it is delivered", async () => {
    mocks.listMappings.mockResolvedValue([
      {
        entityType: "product",
        remoteId: "11",
        localId: "local-11",
        lastPushedPayload: { remoteParentId: "10" },
        updatedAt: null,
      },
    ]);
    // A manual product_update with a price is still undelivered; the local
    // price also differs from last-pushed, so the old diff would have queued
    // an automatic price push to race (and possibly overwrite) the manual one.
    const inserts = stubQueries({
      manualProductUpdates: [{ remote_id: "11", payload: { regular_price: "250" } }],
    });

    await refreshOutboxForConnection(connection());

    expect(inserts.some((i) => i.params[2] === "price")).toBe(false);
    // The stock axis has no manual edit pending — it still flows.
    expect(inserts.some((i) => i.params[2] === "stock")).toBe(true);
  });
});

describe("refreshOutboxForConnection — stock semantics and per-product switches (issue #943)", () => {
  it("queues an external product's price but NEVER a stock figure — the shape guard, not the connection switch", async () => {
    // An affiliate listing is sold on someone else's site. The stubbed
    // item_stock row below proves the point: even when a stale local quantity
    // exists, `stockTracked: false` must stop the tick from fabricating it
    // into the store's live inventory.
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "60", localId: "local-60", lastPushedPayload: { wooType: "external" }, updatedAt: null },
    ]);
    const inserts = stubQueries();

    await refreshOutboxForConnection(connection());

    expect(inserts.some((i) => i.params[2] === "price")).toBe(true);
    expect(inserts.some((i) => i.params[2] === "stock")).toBe(false);
  });

  it("holds a paused axis back while the other one still flows — the pause stops the automation, not the queue", async () => {
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "61", localId: "local-61", lastPushedPayload: { wooType: "simple", stockPushPaused: true }, updatedAt: null },
    ]);
    const stockPaused = stubQueries();
    await refreshOutboxForConnection(connection());
    expect(stockPaused.some((i) => i.params[2] === "stock")).toBe(false);
    expect(stockPaused.some((i) => i.params[2] === "price")).toBe(true);

    vi.clearAllMocks();
    mocks.getBusinessIndustry.mockResolvedValue("accessories");
    mocks.hasSellableCatalogue.mockReturnValue(true);
    mocks.parentRemoteIdFor.mockResolvedValue(null);
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "61", localId: "local-61", lastPushedPayload: { wooType: "simple", pricePushPaused: true }, updatedAt: null },
    ]);
    const pricePaused = stubQueries();
    await refreshOutboxForConnection(connection());
    expect(pricePaused.some((i) => i.params[2] === "price")).toBe(false);
    expect(pricePaused.some((i) => i.params[2] === "stock")).toBe(true);
  });

  it("ignores a paused flag that is not exactly `true` — a corrupted meta value must not silently stop pushes", async () => {
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "62", localId: "local-62", lastPushedPayload: { wooType: "simple", stockPushPaused: "true" }, updatedAt: null },
    ]);
    const inserts = stubQueries();

    await refreshOutboxForConnection(connection());

    expect(inserts.some((i) => i.params[2] === "stock")).toBe(true);
  });

  it("carries the variation parent into the payload in plugin mode too — both transports read the same routing rule", async () => {
    mocks.listMappings.mockResolvedValue([
      { entityType: "product", remoteId: "11", localId: "local-11", lastPushedPayload: { wooType: "variation", remoteParentId: "10" }, updatedAt: null },
    ]);
    const inserts = stubQueries();

    await refreshOutboxForConnection(connection({ link_mode: "plugin" }));

    const stock = inserts.find((i) => i.params[2] === "stock");
    expect(stock).toBeTruthy();
    // The plugin's job lease COALESCEs __parentRemoteId from the payload or
    // the mapping meta; writing it into the payload keeps the two transports
    // on one rule instead of one reading the payload and one reading meta.
    expect(JSON.parse(String(stock!.params[5]))).toMatchObject({ __parentRemoteId: "10" });
  });
});

describe("drainOutbox — legacy rows without __parentRemoteId", () => {
  function stubDrain(payload: Record<string, unknown>) {
    const updateAt = vi.fn().mockResolvedValue(undefined);
    mocks.wooClientFor.mockReturnValue({ updateAt });
    const sent: { sql: string; params: unknown[] }[] = [];
    vi.mocked(query).mockImplementation((async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("SELECT id, entity_type, remote_id, payload, attempts")) {
        return {
          rows: [{ id: "ev-1", entity_type: "stock", remote_id: "11", payload, attempts: 0 }],
        };
      }
      if (text.includes("SELECT last_pushed_payload FROM integration_mappings")) {
        return { rows: [{ last_pushed_payload: { remoteParentId: "10", stock: 1 } }] };
      }
      sent.push({ sql: text, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }) as never);
    return updateAt;
  }

  it("resolves the parent from the mapping when the queued payload predates the fix", async () => {
    // Rows queued before issue #943 carry no __parentRemoteId; the drain must
    // fall back to the mapping metadata (the same COALESCE the plugin's job
    // lease does) instead of 404ing against products/11.
    mocks.parentRemoteIdFor.mockResolvedValue("10");
    const updateAt = stubDrain({ stock_quantity: 3, manage_stock: true });

    await drainOutbox(connection());

    expect(updateAt).toHaveBeenCalledWith("products/10/variations/11", { stock_quantity: 3, manage_stock: true });
    expect(mocks.parentRemoteIdFor).toHaveBeenCalledWith("biz-1", "conn-1", "11");
  });

  it("trusts the payload's own parent and skips the lookup when it is there", async () => {
    const updateAt = stubDrain({ stock_quantity: 3, manage_stock: true, __parentRemoteId: "10" });

    await drainOutbox(connection());

    expect(updateAt).toHaveBeenCalledWith("products/10/variations/11", { stock_quantity: 3, manage_stock: true });
    expect(mocks.parentRemoteIdFor).not.toHaveBeenCalled();
    // Reserved keys never reach the store.
    expect(updateAt.mock.calls[0][1]).not.toHaveProperty("__parentRemoteId");
  });

  it("keeps the mapping's parent metadata when it records what was pushed", async () => {
    mocks.parentRemoteIdFor.mockResolvedValue("10");
    stubDrain({ stock_quantity: 3, manage_stock: true });

    await drainOutbox(connection());

    // setLastPushedPayload replaces wholesale — the drain must merge over the
    // previous meta or a stock push would erase the parent id and re-break
    // the next one.
    expect(mocks.setLastPushedPayload).toHaveBeenCalledWith(
      "biz-1",
      "conn-1",
      "product",
      "11",
      expect.objectContaining({ remoteParentId: "10", stock: 3 }),
    );
  });
});

describe("acknowledgePushedEvent — the ack both delivery paths must persist (Codex P1)", () => {
  function stubAck(previous: Record<string, unknown>) {
    vi.mocked(query).mockImplementation((async (sql: string) => {
      const text = String(sql);
      if (text.includes("SELECT last_pushed_payload FROM integration_mappings")) {
        return { rows: [{ last_pushed_payload: previous }] };
      }
      if (text.includes("SELECT local_id FROM integration_mappings")) {
        return { rows: [{ local_id: "item-55" }] };
      }
      if (text.includes("item_stock")) return { rows: [LOCAL_STATE] };
      return { rows: [] };
    }) as never);
  }

  it("records a delivered stock push over the previous meta, keeping the parent id", async () => {
    stubAck({ wooType: "variation", remoteParentId: "54", priceRial: "500" });
    await acknowledgePushedEvent(connection(), {
      entity_type: "stock",
      remote_id: "55",
      payload: { stock_quantity: 7, manage_stock: true },
    });
    expect(mocks.setLastPushedPayload).toHaveBeenCalledWith("biz-1", "conn-1", "product", "55", {
      wooType: "variation",
      remoteParentId: "54",
      priceRial: "500",
      stock: 7,
    });
  });

  it("records a delivered price push as the LOCAL Rial price, not the store-unit amount", async () => {
    stubAck({ wooType: "simple", stock: 3 });
    await acknowledgePushedEvent(connection(), {
      entity_type: "price",
      remote_id: "55",
      payload: { regular_price: "100" }, // 100 Toman at the store…
    });
    // …but the ack memory is 1000 Rial, the local unit_price (LOCAL_STATE).
    expect(mocks.setLastPushedPayload).toHaveBeenCalledWith("biz-1", "conn-1", "product", "55", {
      wooType: "simple",
      stock: 3,
      priceRial: "1000",
    });
  });

  it("records both axes of a delivered manual product_update", async () => {
    stubAck({ wooType: "simple" });
    await acknowledgePushedEvent(connection(), {
      entity_type: "product_update",
      remote_id: "55",
      payload: { stock_quantity: 4, regular_price: "100" },
    });
    expect(mocks.setLastPushedPayload).toHaveBeenCalledWith("biz-1", "conn-1", "product", "55", {
      wooType: "simple",
      stock: 4,
      priceRial: "1000",
    });
  });
});
