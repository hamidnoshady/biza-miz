/**
 * Issue #903 §8 — a byte sample must only count bytes that are still retained.
 *
 * Retention is enforced by the lifecycle sweep (the row is marked `expired` once
 * its bytes are removed). Sampling such a row would bill a business for storage
 * it no longer uses, so the rule is asserted against the query the sampler
 * actually runs rather than trusted to a comment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({ query: db.query, withoutTenantScope: vi.fn() }));

import { recordStorageSample } from "./tenant-backup-artifacts-service";

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("sum(stored_bytes)")) return { rows: [{ cloud_bytes: "2048", artifact_count: "2" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe("recordStorageSample", () => {
  it("counts only cloud bytes that are still retained", async () => {
    const sampled = await recordStorageSample("business-a", new Date("2026-10-30T12:00:00Z"));

    expect(sampled).toEqual({ cloudBytes: 2048, artifactCount: 2 });
    const select = String(db.query.mock.calls[0][0]);
    expect(select).toContain("destination = 'cloud'");
    // The rule: an expired row's bytes were removed, so they are not billable.
    expect(select).toContain("state NOT IN ('pending_upload', 'expired')");
    expect(select).not.toContain("state <> 'pending_upload'");
  });

  it("records the sample once per instant, so a retried tick is a duplicate", async () => {
    await recordStorageSample("business-a", new Date("2026-10-30T12:00:00Z"));
    const insert = String(db.query.mock.calls[1][0]);
    expect(insert).toContain("ON CONFLICT (business_id, sampled_at) DO NOTHING");
  });
});
