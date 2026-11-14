import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockWithTenantTransaction, mockIsRemoteEditSuppressed } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockWithTenantTransaction: vi.fn(),
  mockIsRemoteEditSuppressed: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mockQuery,
  withTenantTransaction: mockWithTenantTransaction,
}));

vi.mock("./service", () => ({
  isRemoteEditSuppressed: mockIsRemoteEditSuppressed,
}));

import {
  canPublishConnectionOutbound,
  checkManualProductOutboundGuard,
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

    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await shouldDeferWebhookForReconciliation("biz-1", "conn-1", "order.created")).toBe(false);

    expect(await shouldDeferWebhookForReconciliation("biz-1", "conn-1", "plugin.heartbeat")).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(2);
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
});
