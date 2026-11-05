import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), apply: vi.fn(), reconcile: vi.fn() }));

vi.mock("../db", () => ({
  query: mocks.query,
  isPinnedToTransaction: () => false,
  withTenantTransaction: async (_: string, fn: () => unknown) => fn(),
}));
vi.mock("../media-service", () => ({ reconcileWordPressMediaLifecycle: mocks.reconcile }));
vi.mock("./wp-attachment-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./wp-attachment-events")>();
  return { ...actual, applyWpAttachmentEvent: mocks.apply };
});

import { applyMediaSnapshot, parseMediaSnapshot } from "./wp-media-snapshot";
import type { ConnectionRow } from "./connections-service";

const connection = { id: "site", business_id: "tenant", status: "active" } as unknown as ConnectionRow;
const generation = "9f1c2f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

type StoredSnapshot = { boundary: string; expected_count: number | null; completed_at: string | null; started_at: string };

/** Routes each SQL statement applyMediaSnapshot issues to a scripted answer. */
function store(
  snapshot: StoredSnapshot | null,
  options: { members?: { count: number; max: number }; removed?: string[] } = {},
) {
  mocks.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM integration_wp_media_snapshots")) return { rows: snapshot ? [snapshot] : [] };
    if (text.includes("count(*)::int AS count")) return { rows: [options.members ?? { count: 0, max: 0 }] };
    if (text.includes("DELETE FROM integration_wp_content")) return { rows: (options.removed ?? []).map((id) => ({ remote_id: id })) };
    return { rows: [] };
  });
}

const rows = (fragment: string) => mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.apply.mockResolvedValue(true);
  mocks.reconcile.mockResolvedValue(undefined);
});

describe("#941 media snapshot envelope validation", () => {
  it("accepts a well-formed page and a well-formed completion marker", () => {
    expect(parseMediaSnapshot({ id: generation, boundary: "12", index: 1 }, false)).toEqual({
      id: generation,
      boundary: "12",
      index: 1,
    });
    expect(parseMediaSnapshot({ id: generation, boundary: "12", count: 0 }, true)).toEqual({
      id: generation,
      boundary: "12",
      count: 0,
    });
  });

  it("rejects a missing or malformed generation id and boundary", () => {
    expect(() => parseMediaSnapshot(null, true)).toThrow("invalid_media_snapshot");
    expect(() => parseMediaSnapshot({ boundary: "1", count: 1 }, true)).toThrow("invalid_media_snapshot");
    expect(() => parseMediaSnapshot({ id: "not-a-uuid", boundary: "1", count: 1 }, true)).toThrow("invalid_media_snapshot");
    expect(() => parseMediaSnapshot({ id: generation, boundary: "0", count: 1 }, true)).toThrow("invalid_media_snapshot");
  });

  it("rejects out-of-range ordinals and counts", () => {
    expect(() => parseMediaSnapshot({ id: generation, boundary: "1", index: 0 }, false)).toThrow("invalid_media_snapshot_count");
    expect(() => parseMediaSnapshot({ id: generation, boundary: "1", count: 500001 }, true)).toThrow("invalid_media_snapshot_count");
    expect(() => parseMediaSnapshot({ id: generation, boundary: "1" }, true)).toThrow("invalid_media_snapshot_count");
  });

  it("refuses to apply a page that carries no count or index at all", async () => {
    await expect(applyMediaSnapshot(connection, { id: generation, boundary: "1" })).rejects.toThrow(
      "invalid_media_snapshot_count",
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("#941 a snapshot reconciles only once the set is provably complete", () => {
  it("mirrors the page and counts it, but does not prune while the set is short", async () => {
    store({ boundary: "7", expected_count: 3, completed_at: null, started_at: "2026-11-01T00:00:00Z" }, { members: { count: 2, max: 2 } });
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", index: 2 }, { id: 42, type: "attachment" });
    expect(mocks.apply).toHaveBeenCalledWith(connection, { id: 42, type: "attachment" }, false);
    expect(rows("INSERT INTO integration_wp_media_snapshot_members")[0]?.[1]).toEqual([
      "tenant",
      "site",
      generation,
      "42",
      2,
    ]);
    expect(rows("DELETE FROM integration_wp_content")).toHaveLength(0);
    expect(rows("completed_at = now()")).toHaveLength(0);
  });

  it("never prunes from a completion marker alone when members are missing", async () => {
    let snapshotRow: StoredSnapshot = { boundary: "7", expected_count: null, completed_at: null, started_at: "2026-11-01T00:00:00Z" };
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("FROM integration_wp_media_snapshots")) return { rows: [{ ...snapshotRow }] };
      if (text.includes("SET expected_count")) {
        snapshotRow = { ...snapshotRow, expected_count: Number(params?.[3]) };
        return { rows: [] };
      }
      // Two of the three promised pages actually arrived, and they are not
      // contiguous, so the generation can never be proven complete.
      if (text.includes("count(*)::int AS count")) return { rows: [{ count: 2, max: 3 }] };
      return { rows: [] };
    });
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", count: 3 });
    expect(snapshotRow.expected_count).toBe(3);
    expect(rows("DELETE FROM integration_wp_content")).toHaveLength(0);
    expect(rows("SET completed_at = now()")).toHaveLength(0);
    expect(rows("UPDATE integration_connections SET last_media_sync_at")).toHaveLength(0);
  });

  it("stages each page transactionally and marks the generation complete exactly once", async () => {
    let snapshotRow: StoredSnapshot = { boundary: "7", expected_count: null, completed_at: null, started_at: "2026-11-01T00:00:00Z" };
    let members = { count: 0, max: 0 };
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("FROM integration_wp_media_snapshots")) return { rows: [{ ...snapshotRow }] };
      if (text.includes("SET expected_count")) {
        snapshotRow = { ...snapshotRow, expected_count: Number(params?.[3]) };
        return { rows: [] };
      }
      if (text.includes("INSERT INTO integration_wp_media_snapshot_members")) {
        members = { count: members.count + 1, max: Number(params?.[4]) };
        return { rows: [] };
      }
      if (text.includes("count(*)::int AS count")) return { rows: [{ ...members }] };
      if (text.includes("SET completed_at = now()")) {
        snapshotRow = { ...snapshotRow, completed_at: "2026-11-01T00:01:00Z" };
        return { rows: [] };
      }
      return { rows: [] };
    });

    await applyMediaSnapshot(connection, { id: generation, boundary: "7", index: 1 }, { id: 42, type: "attachment" });
    expect(snapshotRow.completed_at).toBeNull();

    await applyMediaSnapshot(connection, { id: generation, boundary: "7", index: 2 }, { id: 43, type: "attachment" });
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", count: 2 });
    expect(snapshotRow.completed_at).not.toBeNull();
    expect(rows("UPDATE integration_connections SET last_media_sync_at")).toHaveLength(1);

    // A later duplicate completion is a no-op.
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", count: 2 });
    expect(rows("UPDATE integration_connections SET last_media_sync_at")).toHaveLength(1);
  });

  it("invalidates only the attachments the snapshot proved absent", async () => {
    store({ boundary: "7", expected_count: 2, completed_at: null, started_at: "2026-11-01T00:00:00Z" }, {
      members: { count: 2, max: 2 },
      removed: ["77", "78"],
    });
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", index: 2 }, { id: 42, type: "attachment" });

    const [prune] = rows("DELETE FROM integration_wp_content");
    // Pruning stays inside the generation boundary and skips anything a live
    // event has already touched with a newer revision.
    expect(String(prune?.[0])).toContain("c.wp_type = 'attachment'");
    expect(String(prune?.[0])).toContain("m.generation = $3");
    expect(String(prune?.[0])).toContain("s.revision > $5");
    expect(prune?.[1]).toEqual(["tenant", "site", generation, "2026-11-01T00:00:00Z", "7"]);

    expect(mocks.reconcile.mock.calls).toEqual([
      ["tenant", "site", "77", "deleted"],
      ["tenant", "site", "78", "deleted"],
    ]);
    expect(rows("INSERT INTO integration_wp_media_state")).toHaveLength(2);
  });
});

describe("#941 conflicting generations never overwrite each other", () => {
  it("rejects a page whose boundary disagrees with the staged generation", async () => {
    store({ boundary: "7", expected_count: null, completed_at: null, started_at: "2026-11-01T00:00:00Z" });
    await expect(
      applyMediaSnapshot(connection, { id: generation, boundary: "8", index: 1 }, { id: 42, type: "attachment" }),
    ).rejects.toThrow("media_snapshot_conflict");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects a completion marker that contradicts the delivered page count", async () => {
    store({ boundary: "7", expected_count: 3, completed_at: null, started_at: "2026-11-01T00:00:00Z" });
    await expect(applyMediaSnapshot(connection, { id: generation, boundary: "7", count: 5 })).rejects.toThrow(
      "media_snapshot_count_conflict",
    );
  });

  it("ignores any further page for an already-completed generation", async () => {
    store({ boundary: "7", expected_count: 2, completed_at: "2026-11-01T00:01:00Z", started_at: "2026-11-01T00:00:00Z" });
    await applyMediaSnapshot(connection, { id: generation, boundary: "7", index: 1 }, { id: 42, type: "attachment" });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(rows("INSERT INTO integration_wp_media_snapshot_members")).toHaveLength(0);
  });
});
