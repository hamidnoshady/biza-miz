import { describe, expect, test } from "vitest";
import {
  entryKey,
  isValidExpectedVersion,
  planEntrySave,
  type EntryVersion,
  type VersionedEntryUpdate,
} from "./price-list-conflicts";

const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

function stored(price: number, version = "1000"): Map<string, EntryVersion> {
  return new Map([[entryKey(LIST, ITEM), { price, version, updatedAt: "2026-10-01T08:00:00.000Z" }]]);
}

function cell(price: number | null, expectedVersion?: string | null): VersionedEntryUpdate {
  const update: VersionedEntryUpdate = { priceListId: LIST, itemId: ITEM, price };
  if (expectedVersion !== undefined) update.expectedVersion = expectedVersion;
  return update;
}

describe("isValidExpectedVersion", () => {
  test("accepts absent, null and a decimal version", () => {
    expect(isValidExpectedVersion(undefined)).toBe(true);
    expect(isValidExpectedVersion(null)).toBe(true);
    expect(isValidExpectedVersion("1759305600123456")).toBe(true);
  });

  test("refuses anything else rather than downgrading it to unconditional", () => {
    for (const bad of ["", "12a", "-1", "1.5", 123, {}, "1".repeat(21)]) {
      expect(isValidExpectedVersion(bad)).toBe(false);
    }
  });
});

describe("planEntrySave", () => {
  test("a matching version updates the row", () => {
    const plan = planEntrySave([cell(60_000, "1000")], stored(50_000));
    expect(plan.updates).toHaveLength(1);
    expect(plan.conflicts).toEqual([]);
  });

  test("a stale version is a conflict carrying the current value, version and time", () => {
    const plan = planEntrySave([cell(60_000, "999")], stored(55_000, "1000"));
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        priceListId: LIST,
        itemId: ITEM,
        requestedPrice: 60_000,
        currentPrice: 55_000,
        currentVersion: "1000",
        updatedAt: "2026-10-01T08:00:00.000Z",
      },
    ]);
  });

  test("a stale version whose row already holds the requested value is not a conflict", () => {
    const plan = planEntrySave([cell(55_000, "999")], stored(55_000, "1000"));
    expect(plan).toEqual({ updates: [], inserts: [], deletes: [], conflicts: [] });
  });

  test("a cell loaded empty is a strict insert while it stays empty", () => {
    const plan = planEntrySave([cell(70_000, null)], new Map());
    expect(plan.inserts).toEqual([{ update: cell(70_000, null), strict: true }]);
  });

  test("a cell loaded empty that someone filled meanwhile is a conflict", () => {
    const plan = planEntrySave([cell(70_000, null)], stored(65_000, "2000"));
    expect(plan.inserts).toEqual([]);
    expect(plan.conflicts[0]).toMatchObject({ currentPrice: 65_000, currentVersion: "2000" });
  });

  test("a row deleted after load is a conflict for a write, a no-op for a clear", () => {
    const write = planEntrySave([cell(70_000, "1000")], new Map());
    expect(write.conflicts[0]).toMatchObject({ currentPrice: null, currentVersion: null, updatedAt: null });

    const clear = planEntrySave([cell(null, "1000")], new Map());
    expect(clear).toEqual({ updates: [], inserts: [], deletes: [], conflicts: [] });
  });

  test("clearing a row at its version deletes it; at a stale version it conflicts", () => {
    expect(planEntrySave([cell(null, "1000")], stored(50_000)).deletes).toHaveLength(1);
    const stale = planEntrySave([cell(null, "999")], stored(50_000));
    expect(stale.deletes).toEqual([]);
    expect(stale.conflicts[0]).toMatchObject({ requestedPrice: null, currentPrice: 50_000 });
  });

  test("an older client without a version keeps last-write-wins", () => {
    const update = planEntrySave([cell(60_000)], stored(55_000, "1000"));
    expect(update.updates).toHaveLength(1);
    expect(update.conflicts).toEqual([]);

    const insert = planEntrySave([cell(60_000)], new Map());
    expect(insert.inserts).toEqual([{ update: cell(60_000), strict: false }]);

    expect(planEntrySave([cell(null)], stored(55_000)).deletes).toHaveLength(1);
  });

  test("an unchanged value is skipped so it does not bump the version under another editor", () => {
    expect(planEntrySave([cell(50_000, "1000")], stored(50_000))).toEqual({
      updates: [],
      inserts: [],
      deletes: [],
      conflicts: [],
    });
  });
});
