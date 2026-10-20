/**
 * Issue #944 / OVR-03 — the overview and the Queue page share one
 * status-to-KPI classification, so their counts reconcile for every
 * outbound/inbound status, per store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { summarizeQueueCounts, wpOverviewStats, wpQueueSummary } from "./wp-manager-service";

vi.mock("../db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  closeDatabasePool: vi.fn(),
  withTenant: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  rlsEffective: vi.fn(),
  assertRlsEffective: vi.fn(),
}));
vi.mock("./connections-service", () => ({ getConnection: vi.fn() }));
vi.mock("./outbox-service", () => ({ drainOutbox: vi.fn() }));
vi.mock("./webhook-ingest-service", () => ({ reprocessExistingIngestEvent: vi.fn() }));
vi.mock("./wp-content-service", () => ({
  wpContentCounts: vi.fn(async () => ({ posts: 1, pages: 2, media: 3 })),
}));

const OUTBOX = new Map([
  ["pending", 3],
  ["processing", 2],
  ["failed", 4],
  ["needs_review", 5],
  ["dead", 6],
  ["sent", 100],
]);
const INBOX = new Map([
  ["pending", 7],
  ["deferred", 8],
  ["failed", 9],
  ["processed", 200],
]);

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("summarizeQueueCounts", () => {
  it("classifies every outbound and inbound status exactly once", () => {
    const summary = summarizeQueueCounts(OUTBOX, INBOX);
    expect(summary.pending).toBe(3 + 7 + 8);
    expect(summary.processing).toBe(2);
    expect(summary.inFlight).toBe(3 + 7 + 8 + 2);
    expect(summary.failed).toBe(4 + 5 + 9);
    expect(summary.needsReview).toBe(5);
    expect(summary.dead).toBe(6);
    expect(summary.attention).toBe(4 + 5 + 9 + 6);
    expect(summary.open).toBe(summary.inFlight + summary.attention);
    expect(summary.sent).toBe(300);
    expect(summary.deferred).toBe(8);
    expect(summary.inboundPending).toBe(15);
    expect(summary.inboundFailed).toBe(9);
    expect(summary.outboundFailed).toBe(4 + 6 + 5);
    expect(summary.total).toBe(120 + 224);
    // Nothing open is left out, nothing done is counted as open.
    expect(summary.open + summary.sent).toBe(summary.total);
  });

  it("never implies a backlog is zero when only the inbox has work", () => {
    const summary = summarizeQueueCounts(new Map(), new Map([["deferred", 2], ["failed", 1]]));
    expect(summary.inFlight).toBe(2);
    expect(summary.attention).toBe(1);
    expect(summary.open).toBe(3);
  });

  it("is all zeros for an empty queue", () => {
    const summary = summarizeQueueCounts(new Map(), new Map());
    expect(Object.values(summary).every((n) => n === 0)).toBe(true);
  });
});

function rowsOf(map: ReadonlyMap<string, number>) {
  return Array.from(map.entries()).map(([status, n]) => ({ status, n: String(n) }));
}

describe("overview and queue summary reconcile per store", () => {
  it("wpOverviewStats.queue equals wpQueueSummary for the same connection", async () => {
    const q = vi.mocked(query);
    // wpOverviewStats: connections, mappings, terms, (content via mock), outbox, inbox.
    q.mockResolvedValueOnce({ rows: [{ total: "1", active: "1", plugin: "1", rest: "0" }] } as never)
      .mockResolvedValueOnce({ rows: [{ entity: "product", n: "10" }] } as never)
      .mockResolvedValueOnce({ rows: [{ n: "4" }] } as never)
      .mockResolvedValueOnce({ rows: rowsOf(OUTBOX) } as never)
      .mockResolvedValueOnce({ rows: rowsOf(INBOX) } as never);
    const overview = await wpOverviewStats("biz-1", "conn-1");

    // wpQueueSummary: outbox, inbox (Promise.all — both are issued before either resolves).
    q.mockResolvedValueOnce({ rows: rowsOf(OUTBOX) } as never).mockResolvedValueOnce({ rows: rowsOf(INBOX) } as never);
    const summary = await wpQueueSummary("biz-1", "conn-1");

    expect(overview.queue).toEqual(summary);
    // The legacy fields still agree with the shared classification.
    expect(overview.failedJobs).toBe(4);
    expect(overview.deadJobs).toBe(6);
    expect(overview.pendingInboxEvents).toBe(summary.inboundPending);
    expect(overview.failedInboxEvents).toBe(summary.inboundFailed);

    // Every store-scoped read of the overview carries the connection id — the
    // counts are this store's, not the business's.
    const scopedCalls = q.mock.calls.slice(0, 5);
    for (const [sql, params] of scopedCalls) {
      expect(String(sql)).toContain("business_id = $1");
      expect(params).toEqual(["biz-1", "conn-1"]);
    }
  });
});
