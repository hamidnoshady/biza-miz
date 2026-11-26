import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockWithTenantTransaction, mockIsRemoteEditSuppressed, mockDuplicateStockConflict } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockWithTenantTransaction: vi.fn(),
  mockIsRemoteEditSuppressed: vi.fn(),
  mockDuplicateStockConflict: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mockQuery,
  withTenantTransaction: mockWithTenantTransaction,
}));

vi.mock("./service", () => ({
  isRemoteEditSuppressed: mockIsRemoteEditSuppressed,
}));

// The outbound authority guard is its own DB read; mocked here so these tests
// keep asserting the guard's decision order rather than a query count.
vi.mock("../integrations/product-authority-guard", () => ({
  duplicateStockConflictForRemote: mockDuplicateStockConflict,
  listDuplicateStockConflicts: vi.fn(async () => new Map()),
}));

import {
  canPublishAnyConnectionOutbound,
  canPublishConnectionOutbound,
  checkManualProductOutboundGuard,
  ensureFirstContactReconciliationGate,
  findReconciliationRunForWebhook,
  hasNewSourceEventsForRun,
  isOutboxFieldSuppressed,
  listSuppressedRemoteEditsForConnection,
  shouldDeferWebhookForReconciliation,
  webhookTopicDomain,
} from "./entry-guards";

describe("import-reconciliation entry & outbound guards (#1118)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockWithTenantTransaction.mockReset();
    mockIsRemoteEditSuppressed.mockReset();
    mockIsRemoteEditSuppressed.mockResolvedValue(false);
    mockDuplicateStockConflict.mockReset();
    mockDuplicateStockConflict.mockResolvedValue(null);
  });

  it("maps webhook topics to reconciliation domains cleanly", () => {
    expect(webhookTopicDomain("product.created")).toBe("product");
    expect(webhookTopicDomain("product.updated")).toBe("product");
    expect(webhookTopicDomain("catalogue.updated")).toBe("product");
    expect(webhookTopicDomain("customer.updated")).toBe("party");
    expect(webhookTopicDomain("order.created")).toBe("financial_document");
    expect(webhookTopicDomain("refund.created")).toBe("financial_document");
    expect(webhookTopicDomain("system.ping")).toBeNull();
  });

  it("defers inbound webhooks when an active run exists for the connection+domain", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "run-1", domain: "product", status: "in_review" }],
    });
    expect(await shouldDeferWebhookForReconciliation("biz-1", "conn-1", "product.updated")).toBe(true);

    // Financial events check their own domain, then any run on the connection.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await shouldDeferWebhookForReconciliation("biz-1", "conn-1", "order.created")).toBe(false);

    expect(await shouldDeferWebhookForReconciliation("biz-1", "conn-1", "plugin.heartbeat")).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("makes an order wait behind a product/party run, not only a financial run", async () => {
    // No financial run owns the order…
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      // …but the first-sync product run still owns the connection.
      .mockResolvedValueOnce({ rows: [{ id: "run-1", domain: "product", status: "discovering" }] });

    await expect(findReconciliationRunForWebhook("biz-1", "conn-1", "order.created")).resolves.toEqual({
      id: "run-1",
      domain: "product",
      status: "discovering",
    });

    // A product topic only checks its own domain; it never consults "any run".
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(findReconciliationRunForWebhook("biz-1", "conn-1", "product.updated")).resolves.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it("detects source events that arrived after the preview was staged", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });
    await expect(
      hasNewSourceEventsForRun({
        businessId: "biz-1",
        domain: "product",
        connectionId: "conn-1",
        stagedAt: "2026-11-20T10:00:00.000Z",
      }),
    ).resolves.toBe(true);
    const params = mockQuery.mock.calls[0]?.[1] as unknown[];
    expect(params).toEqual([
      "biz-1",
      "conn-1",
      "2026-11-20T10:00:00.000Z",
      ["product.created", "product.updated", "catalogue.sync_completed"],
      ["%.product.created", "%.product.updated", "%.catalogue.sync_completed"],
    ]);

    // File runs and domains with no inbox have no source-version signal here.
    await expect(
      hasNewSourceEventsForRun({
        businessId: "biz-1",
        domain: "product",
        connectionId: null,
        stagedAt: "2026-11-20T10:00:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      hasNewSourceEventsForRun({
        businessId: "biz-1",
        domain: "inventory",
        connectionId: "conn-1",
        stagedAt: "2026-11-20T10:00:00.000Z",
      }),
    ).resolves.toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("opens the first-contact gate as discovering so a stage sweep can still populate it", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ exists: true }] }) // product overlap
      .mockResolvedValueOnce({ rows: [] }) // no existing run for product
      .mockResolvedValueOnce({ rows: [{ exists: false }] }); // party has no overlap

    const insert = vi.fn().mockResolvedValue({ rows: [] });
    mockWithTenantTransaction.mockImplementationOnce(async (_businessId, fn: (client: unknown) => unknown) =>
      fn({ query: insert }),
    );

    await expect(
      ensureFirstContactReconciliationGate("biz-1", "conn-1", "loc-1"),
    ).resolves.toEqual({ gatedDomains: ["product"] });
    expect(insert).toHaveBeenCalledTimes(1);
    const [sql] = insert.mock.calls[0] as [string];
    expect(sql).toContain("INSERT INTO import_reconciliation_runs");
    expect(sql).not.toMatch(/\bstatus\b/);
    expect(sql).not.toContain("'staged'");
  });

  it("blocks connection outbound publication when source_of_truth is store or reconciliation is active", async () => {
    expect(
      await canPublishConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "store" }),
    ).toEqual({ allowed: false, reason: "source_of_truth_store" });
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "run-1", domain: "product", status: "staged" }],
    });
    expect(
      await canPublishConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "pos" }),
    ).toEqual({ allowed: false, reason: "reconciliation_active" });

    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(
      await canPublishConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "two_way" }),
    ).toEqual({ allowed: true });
  });

  it("blocks the Holoo accounting channel behind any active run, not only a product one", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "run-inv", domain: "inventory", status: "in_review" }] });
    await expect(
      canPublishAnyConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "pos" }),
    ).resolves.toEqual({ allowed: false, reason: "reconciliation_active" });

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      canPublishAnyConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "two_way" }),
    ).resolves.toEqual({ allowed: true });

    // A store-owned connection never receives accounting pushes.
    await expect(
      canPublishAnyConnectionOutbound("biz-1", { id: "conn-1", source_of_truth: "store" }),
    ).resolves.toEqual({ allowed: false, reason: "source_of_truth_store" });
  });

  it("suppresses outbox values matching rejected remote edits across aliases & formats", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { external_id: "42", field: "regular_price", fingerprint: "regular_price=150000" },
        { external_id: "42", field: "stock_quantity", fingerprint: "stock_quantity=7" },
      ],
    });
    const set = await listSuppressedRemoteEditsForConnection("biz-1", "conn-1");
    expect(isOutboxFieldSuppressed(set, "42", "regular_price", 150000)).toBe(true);
    expect(isOutboxFieldSuppressed(set, "42", "regular_price", "150000.00")).toBe(true);
    expect(isOutboxFieldSuppressed(set, "42", "regular_price", "160000")).toBe(false);
    expect(isOutboxFieldSuppressed(set, "42", "stock_quantity", 7)).toBe(true);
    expect(isOutboxFieldSuppressed(set, "42", "stock_quantity", 8)).toBe(false);
    expect(isOutboxFieldSuppressed(set, "99", "regular_price", 150000)).toBe(false);
  });

  it("blocks manual outbound pushes when unapplied item or rejected edit matches, allows distinct values once applied", async () => {
    // 1. Active run blocks immediately
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "run-1", domain: "product", status: "staged" }],
    });
    expect(
      await checkManualProductOutboundGuard("biz-1", { id: "conn-1", source_of_truth: "pos" }, "42", {
        regular_price: "150000",
      }),
    ).toEqual({ ok: false, reason: "reconciliation_active" });

    // 2. Closed run + suppressed value blocks
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no active run
      .mockResolvedValueOnce({
        rows: [
          {
            run_status: "applied",
            item_status: "applied",
            canonical_id: "item-1",
            cutover_authority: "books",
            ownership_confirmed: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ external_id: "42", field: "regular_price", fingerprint: "regular_price=150000" }],
      });
    expect(
      await checkManualProductOutboundGuard("biz-1", { id: "conn-1", source_of_truth: "pos" }, "42", {
        regular_price: "150000",
      }),
    ).toEqual({ ok: false, reason: "rejected_edit_suppressed" });

    // 3. New value not suppressed -> allowed
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            run_status: "applied",
            item_status: "applied",
            canonical_id: "item-1",
            cutover_authority: "books",
            ownership_confirmed: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ external_id: "42", field: "regular_price", fingerprint: "regular_price=150000" }],
      });
    expect(
      await checkManualProductOutboundGuard("biz-1", { id: "conn-1", source_of_truth: "pos" }, "42", {
        regular_price: "175000",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a manual stock/price push while an unmapped twin holds the stock (issue #1592)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no active run
    mockDuplicateStockConflict.mockResolvedValueOnce({
      localId: "item-1",
      twinItemId: "item-2",
      twinQuantity: "5",
    });
    await expect(
      checkManualProductOutboundGuard("biz-1", { id: "conn-1", source_of_truth: "pos" }, "42", {
        stock_quantity: 9,
      }),
    ).resolves.toEqual({ ok: false, reason: "duplicate_stock_conflict" });
  });
});
