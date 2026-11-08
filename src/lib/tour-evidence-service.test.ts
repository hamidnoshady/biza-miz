/**
 * Issue #972 phase 2 — the evidence row is the only thing that can complete an
 * `action` step, so this file holds two guarantees a tour depends on:
 *
 *  - the credited action is the caller's own (business, member, verifier), and
 *    an unregistered verifier is ignored rather than stored;
 *  - recording is genuinely best-effort. A broken evidence table must cost a
 *    tour step a retry, never the sale/product/customer the member just saved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query: mocks.query }));

import { hasTourEvidence, recordTourEvidence } from "./tour-evidence-service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("recording evidence", () => {
  it("upserts one row per member and verifier — a counter, not a log", async () => {
    await recordTourEvidence({ businessId: "biz-1", userId: "user-1", verifier: "product.created", entityId: "item-1" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("ON CONFLICT (business_id, user_id, verifier) DO UPDATE");
    expect(String(sql)).toContain("count = tour_action_evidence.count + 1");
    expect(params).toEqual(["biz-1", "user-1", "product.created", "item-1"]);
  });

  it("stores no payload: the entity id is truncated, and nothing else is sent", async () => {
    await recordTourEvidence({
      businessId: "biz-1",
      userId: "user-1",
      verifier: "party.created",
      entityId: "x".repeat(200),
    });
    const [, params] = mocks.query.mock.calls[0];
    expect(params[3]).toHaveLength(64);
  });

  it("ignores a verifier that is not in the reviewed whitelist", async () => {
    await recordTourEvidence({
      businessId: "biz-1",
      userId: "user-1",
      verifier: "made.up" as never,
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("never fails the business action when the write fails", async () => {
    mocks.query.mockRejectedValue(new Error("relation tour_action_evidence does not exist"));
    await expect(
      recordTourEvidence({ businessId: "biz-1", userId: "user-1", verifier: "order.created" }),
    ).resolves.toBeUndefined();
  });
});

describe("reading evidence", () => {
  it("answers null when the member has not done it", async () => {
    expect(await hasTourEvidence("biz-1", "user-1", "order.created")).toBeNull();
  });

  it("returns when it last happened, so the UI can say «قبلاً هم انجام داده‌اید»", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ last_at: new Date("2026-01-02T03:04:05.000Z"), count: 3 }],
    });
    expect(await hasTourEvidence("biz-1", "user-1", "order.created")).toEqual({
      verifier: "order.created",
      lastAt: "2026-01-02T03:04:05.000Z",
      count: 3,
    });
    // Scoped to the caller: the query names the business, the member and the verifier.
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("business_id = $1 AND user_id = $2"), [
      "biz-1",
      "user-1",
      "order.created",
    ]);
  });
});
