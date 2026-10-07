import { describe, expect, it } from "vitest";
import {
  decodeReconciliationCursor,
  encodeReconciliationCursor,
  type ReconciliationCursor,
} from "./bank-reconciliation-cursor";

const CURSOR: ReconciliationCursor = {
  entryDate: "2026-09-30",
  postedAt: "2026-09-30 12:34:56.789+00",
  entryId: "6f1d5f6a-2b6c-4a11-9d40-2f8a5c0f0d21",
  journalLineId: "4821",
};

describe("the reconciliation list's keyset cursor", () => {
  it("round-trips every part of the sort key", () => {
    expect(decodeReconciliationCursor(encodeReconciliationCursor(CURSOR))).toEqual(CURSOR);
  });

  it("treats an absent cursor as the first page", () => {
    expect(decodeReconciliationCursor(null)).toBeNull();
    expect(decodeReconciliationCursor(undefined)).toBeNull();
    expect(decodeReconciliationCursor("")).toBeNull();
  });

  /**
   * `?cursor=` is caller-supplied text that ends up in a `date`, a
   * `timestamptz`, a `uuid` and a `bigint` comparison. A malformed one has to
   * be refused here, not discovered by Postgres as a cast error and answered to
   * the reader as a 500.
   */
  it("refuses anything that is not one of its own cursors", () => {
    expect(decodeReconciliationCursor("nonsense")).toBeNull();
    expect(decodeReconciliationCursor("2026-09-30|2026-09-30 12:34:56+00")).toBeNull();
    expect(decodeReconciliationCursor("not-a-date|2026-09-30 12:34:56+00|6f1d5f6a-2b6c-4a11-9d40-2f8a5c0f0d21|4821")).toBeNull();
    expect(decodeReconciliationCursor("2026-09-30|2026-09-30 12:34:56+00|not-a-uuid|4821")).toBeNull();
    expect(decodeReconciliationCursor("2026-09-30|2026-09-30 12:34:56+00|6f1d5f6a-2b6c-4a11-9d40-2f8a5c0f0d21|12;DROP")).toBeNull();
    expect(decodeReconciliationCursor("2026-09-30||6f1d5f6a-2b6c-4a11-9d40-2f8a5c0f0d21|4821")).toBeNull();
  });
});
