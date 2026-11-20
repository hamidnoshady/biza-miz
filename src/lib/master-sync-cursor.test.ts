/**
 * Issue #1446 — the master-data cursor and the bounded conflict policy.
 *
 * The transport used to advance its cursor past a change that never applied,
 * leaving only the `sync_master_conflicts` row. The policy now is explicit:
 * a retryable failure stops the cursor for a bounded number of attempts, then
 * the change is quarantined and the cursor moves on so unrelated changes are
 * never starved. These tests pin that policy without a database.
 */
import { describe, expect, it } from "vitest";
import {
  cursorAfterApply,
  MASTER_CURSOR_START,
  MAX_CONFLICT_ATTEMPTS,
  MAX_DEPENDENCY_ATTEMPTS,
  masterApplyOutcomeForFailure,
  type MasterCursor,
  type MasterFeedChange,
} from "./master-sync-service";

function change(txid: string, table: string, rowId: string): MasterFeedChange {
  return {
    table,
    rowId,
    deleted: false,
    rowHlc: "000000000000010.000000000000001.node",
    clocks: {},
    row: {},
    writerNode: null,
    locationId: null,
    txid,
  };
}

const page = [
  change("10", "parties", "a"),
  change("10", "parties", "b"),
  change("11", "menu_items", "c"),
];
const pageEnd: MasterCursor = { txid: "11", table: "menu_items", rowId: "c" };

describe("cursorAfterApply", () => {
  it("advances to the page end when every change settled", () => {
    expect(cursorAfterApply(MASTER_CURSOR_START, pageEnd, page, -1)).toEqual(pageEnd);
  });

  it("stops immediately before the first deferred change", () => {
    expect(cursorAfterApply(MASTER_CURSOR_START, pageEnd, page, 2)).toEqual({
      txid: "10",
      table: "parties",
      rowId: "b",
    });
  });

  it("does not move when the very first change is deferred", () => {
    expect(cursorAfterApply(MASTER_CURSOR_START, pageEnd, page, 0)).toEqual(
      MASTER_CURSOR_START,
    );
  });

  it("advances past a terminal conflict and stops only at the deferred change after it", () => {
    // The first page change is a terminal conflict (not in `changes` as an
    // input here — only the first *deferred* index matters), the second is
    // deferred: resuming before the second re-delivers it without losing it.
    expect(cursorAfterApply(MASTER_CURSOR_START, pageEnd, page, 1)).toEqual({
      txid: "10",
      table: "parties",
      rowId: "a",
    });
  });
});

describe("masterApplyOutcomeForFailure", () => {
  it("retries a missing parent until the dependency bound, then quarantines it", () => {
    expect(
      masterApplyOutcomeForFailure("dependency_missing", "fk", MAX_DEPENDENCY_ATTEMPTS - 1),
    ).toBe("deferred");
    expect(
      masterApplyOutcomeForFailure("dependency_missing", "fk", MAX_DEPENDENCY_ATTEMPTS),
    ).toBe("conflict");
  });

  it("gives a duplicate natural key a bounded retry, then quarantines it", () => {
    expect(masterApplyOutcomeForFailure("merge_conflict", "unique_violation", 1)).toBe(
      "deferred",
    );
    expect(
      masterApplyOutcomeForFailure("merge_conflict", "unique_violation", MAX_CONFLICT_ATTEMPTS),
    ).toBe("conflict");
  });

  it("quarantines a duplicate employee-party identity immediately (issue #1446)", () => {
    // Retrying cannot invent the missing identity mapping; the conflict is
    // recorded with an actionable code and the cursor must move on.
    expect(
      masterApplyOutcomeForFailure(
        "merge_conflict",
        "employee_party_identity_conflict",
        1,
      ),
    ).toBe("conflict");
  });

  it("quarantines a deterministic merge refusal immediately", () => {
    expect(masterApplyOutcomeForFailure("merge_conflict", "unknown_table", 1)).toBe(
      "conflict",
    );
    expect(masterApplyOutcomeForFailure("merge_conflict", "invalid_clock", 1)).toBe(
      "conflict",
    );
  });

  it("treats an infrastructure error as retryable for a bounded period", () => {
    expect(masterApplyOutcomeForFailure("apply_failed", "40001", 1)).toBe("deferred");
    expect(
      masterApplyOutcomeForFailure("apply_failed", "40001", MAX_CONFLICT_ATTEMPTS),
    ).toBe("conflict");
  });
});
