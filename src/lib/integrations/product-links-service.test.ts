import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { listProductWooLinks } from "./product-links-service";

vi.mock("@/lib/db", () => ({ query: vi.fn() }));

const LINK_ROW = {
  local_id: "local-1",
  connection_id: "connection-1",
  provider: "woocommerce",
  store_name: "فروشگاه اصلی",
  remote_id: "woo-variation-42",
  connection_status: "active",
  last_catalogue_sync_at: "2026-10-21T08:00:00.000Z",
  outbound_status: "pending",
  outbound_sent_at: null,
  outbound_error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue({ rows: [LINK_ROW] } as never);
});

describe("listProductWooLinks", () => {
  it("returns store-specific mappings and truthful sync health for one business and branch", async () => {
    await expect(listProductWooLinks("business-1", "location-1")).resolves.toEqual([
      {
        localId: "local-1",
        connectionId: "connection-1",
        provider: "woocommerce",
        storeName: "فروشگاه اصلی",
        remoteId: "woo-variation-42",
        connectionStatus: "active",
        lastCatalogueSyncAt: "2026-10-21T08:00:00.000Z",
        lastOutboundStatus: "pending",
        lastOutboundSentAt: null,
        lastOutboundError: null,
      },
    ]);

    const [sql, params] = vi.mocked(query).mock.calls[0]!;
    expect(params).toEqual(["business-1", "location-1"]);
    expect(sql).toContain("m.business_id = $1");
    expect(sql).toContain("i.location_id = $2");
    expect(sql).toContain("c.location_id IS NULL OR c.location_id = $2");
    expect(sql).toContain("m.entity_type = 'product'");
    expect(sql).toContain("ORDER BY o.updated_at DESC, o.created_at DESC");
  });
});
