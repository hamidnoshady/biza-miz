import { describe, expect, it } from "vitest";
import { planMasterMerge, type LocalMasterState, type MasterChange } from "./master-sync-merge";
import { hlcNewer, isHlc, maxHlc, ZERO_HLC } from "./sync-hlc";

const COLUMNS = ["id", "name", "phone", "address"] as const;

function stamp(ms: number, seq: number, node: string): string {
  return `${String(ms).padStart(15, "0")}.${String(seq).padStart(15, "0")}.${node}`;
}

const CLOUD_T1 = stamp(1_000, 1, "cloud");
const SITE_T2 = stamp(2_000, 1, "site");
const CLOUD_T3 = stamp(3_000, 2, "cloud");

const ROW = { id: "p1", name: "Sara", phone: "0912", address: "Tehran" };

function change(overrides: Partial<MasterChange> = {}): MasterChange {
  return { table: "parties", rowId: "p1", deleted: false, rowHlc: CLOUD_T1, clocks: {}, row: ROW, ...overrides };
}

function local(overrides: Partial<LocalMasterState> = {}): LocalMasterState {
  return { exists: true, deleted: false, rowHlc: ZERO_HLC, clocks: {}, ...overrides };
}

describe("sync-hlc", () => {
  it("orders stamps as strings and treats the zero clock as oldest", () => {
    expect(isHlc(CLOUD_T1)).toBe(true);
    expect(isHlc(ZERO_HLC)).toBe(true);
    expect(isHlc("2026-01-01")).toBe(false);
    expect(hlcNewer(SITE_T2, CLOUD_T1)).toBe(true);
    expect(hlcNewer(CLOUD_T1, CLOUD_T1)).toBe(false);
    expect(maxHlc(null, CLOUD_T1, SITE_T2, undefined)).toBe(SITE_T2);
    expect(maxHlc()).toBe(ZERO_HLC);
  });
});

describe("planMasterMerge", () => {
  it("keeps both sides' edits to different fields", () => {
    // Cloud changed the phone at T1; the desktop already changed the address at T2.
    const plan = planMasterMerge(
      change({ clocks: { phone: CLOUD_T1 }, row: { ...ROW, phone: "0935", address: "old" } }),
      local({ clocks: { address: SITE_T2 } }),
      COLUMNS,
    );
    expect(plan).toEqual({
      action: "update",
      fields: { phone: "0935" },
      clocks: { phone: CLOUD_T1, address: SITE_T2 },
      incomingDominates: false,
    });
  });

  it("lets the later edit win when both sides changed the same field", () => {
    const newer = planMasterMerge(
      change({ clocks: { name: CLOUD_T3 }, row: { ...ROW, name: "Sara K." } }),
      local({ clocks: { name: SITE_T2 } }),
      COLUMNS,
    );
    expect(newer).toMatchObject({ action: "update", fields: { name: "Sara K." }, incomingDominates: true });

    const older = planMasterMerge(
      change({ clocks: { name: CLOUD_T1 }, row: { ...ROW, name: "stale" } }),
      local({ clocks: { name: SITE_T2 } }),
      COLUMNS,
    );
    expect(older).toEqual({ action: "noop" });
  });

  it("is idempotent: the same change applied twice changes nothing the second time", () => {
    const incoming = change({ clocks: { phone: CLOUD_T1 } });
    const first = planMasterMerge(incoming, local(), COLUMNS);
    expect(first.action).toBe("update");
    const after = first.action === "update" ? first.clocks : {};
    expect(planMasterMerge(incoming, local({ clocks: after }), COLUMNS)).toEqual({ action: "noop" });
  });

  it("changes nothing when both sides hold the untouched backfilled row", () => {
    expect(planMasterMerge(change({ rowHlc: ZERO_HLC, clocks: {} }), local(), COLUMNS)).toEqual({ action: "noop" });
  });

  it("inserts the full row when this side has never seen it", () => {
    const plan = planMasterMerge(change({ clocks: { name: CLOUD_T1 } }), local({ exists: false, rowHlc: null }), COLUMNS);
    expect(plan).toEqual({
      action: "insert",
      fields: ROW,
      clocks: { name: CLOUD_T1 },
      incomingDominates: true,
    });
  });

  it("deletes only when the delete is newer than every local edit", () => {
    expect(
      planMasterMerge(change({ deleted: true, rowHlc: CLOUD_T3, row: null }), local({ clocks: { name: SITE_T2 } }), COLUMNS),
    ).toEqual({ action: "delete", rowHlc: CLOUD_T3 });
    // An edit made after the delete keeps the row.
    expect(
      planMasterMerge(change({ deleted: true, rowHlc: CLOUD_T1, row: null }), local({ clocks: { name: SITE_T2 } }), COLUMNS),
    ).toEqual({ action: "noop" });
  });

  it("does not resurrect a deleted row with an edit older than the delete", () => {
    const tombstone = local({ exists: false, deleted: true, rowHlc: SITE_T2 });
    expect(planMasterMerge(change({ clocks: { name: CLOUD_T1 } }), tombstone, COLUMNS)).toEqual({ action: "noop" });
    expect(planMasterMerge(change({ clocks: { name: CLOUD_T3 } }), tombstone, COLUMNS).action).toBe("insert");
  });

  it("records a tombstone for a row this side never had", () => {
    expect(
      planMasterMerge(change({ deleted: true, rowHlc: CLOUD_T1, row: null }), local({ exists: false, rowHlc: null }), COLUMNS),
    ).toEqual({ action: "tombstone", rowHlc: CLOUD_T1 });
  });

  it("never merges a column outside the synchronised set", () => {
    const plan = planMasterMerge(
      change({ clocks: { avg_cost: CLOUD_T3 }, row: { ...ROW, avg_cost: "999" } }),
      local(),
      COLUMNS,
    );
    expect(plan).toEqual({ action: "noop" });
  });

  it("gives the same result whichever of two concurrent edits arrives first", () => {
    const a = change({ clocks: { phone: CLOUD_T1 }, row: { ...ROW, phone: "A" } });
    const b = change({ clocks: { phone: SITE_T2 }, row: { ...ROW, phone: "B" } });
    const apply = (state: { clocks: Record<string, string>; phone: string }, incoming: MasterChange) => {
      const plan = planMasterMerge(incoming, local({ clocks: state.clocks }), COLUMNS);
      if (plan.action !== "update") return state;
      return { clocks: plan.clocks, phone: (plan.fields.phone as string) ?? state.phone };
    };
    const start = { clocks: {}, phone: "0912" };
    expect(apply(apply(start, a), b)).toEqual(apply(apply(start, b), a));
    expect(apply(apply(start, a), b).phone).toBe("B");
  });
});
