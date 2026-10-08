import { describe, expect, it } from "vitest";
import {
  availableActions,
  canonicalBankName,
  canonicalSerialNumber,
  bucketChequesByDueDate,
  CHEQUE_ACTIONS,
  CHEQUE_DIRECTIONS,
  initialStatus,
  isTerminal,
  nextStatus,
  normalizeSayadId,
  type ChequeStatus,
} from "./cheques";

describe("initialStatus", () => {
  it("starts a cheque we took in the drawer and one we wrote as issued", () => {
    expect(initialStatus("receivable")).toBe("on_hand");
    expect(initialStatus("payable")).toBe("issued");
  });
});

describe("nextStatus — receivable", () => {
  it("walks the ordinary life: taken, banked, cleared", () => {
    expect(nextStatus("receivable", "on_hand", "deposit")).toBe("in_collection");
    expect(nextStatus("receivable", "in_collection", "clear")).toBe("cleared");
  });

  it("lets a cheque in the drawer be endorsed onward, and that one clear or bounce", () => {
    expect(nextStatus("receivable", "on_hand", "endorse")).toBe("endorsed");
    expect(nextStatus("receivable", "endorsed", "clear")).toBe("cleared");
    expect(nextStatus("receivable", "endorsed", "bounce")).toBe("bounced");
  });

  it("can bounce from the drawer or from collection", () => {
    expect(nextStatus("receivable", "on_hand", "bounce")).toBe("bounced");
    expect(nextStatus("receivable", "in_collection", "bounce")).toBe("bounced");
  });

  it("refuses a payable's actions", () => {
    expect(nextStatus("receivable", "on_hand", "present")).toBeNull();
    expect(nextStatus("receivable", "on_hand", "cancel")).toBeNull();
  });

  it("refuses to endorse a cheque already at the bank — it isn't ours to hand over", () => {
    expect(nextStatus("receivable", "in_collection", "endorse")).toBeNull();
  });

  it("refuses to deposit one already deposited or endorsed", () => {
    expect(nextStatus("receivable", "in_collection", "deposit")).toBeNull();
    expect(nextStatus("receivable", "endorsed", "deposit")).toBeNull();
  });
});

describe("nextStatus — payable", () => {
  it("clears when presented, and can bounce or be cancelled before that", () => {
    expect(nextStatus("payable", "issued", "present")).toBe("cleared");
    expect(nextStatus("payable", "issued", "bounce")).toBe("bounced");
    expect(nextStatus("payable", "issued", "cancel")).toBe("cancelled");
  });

  it("refuses a receivable's actions", () => {
    expect(nextStatus("payable", "issued", "deposit")).toBeNull();
    expect(nextStatus("payable", "issued", "endorse")).toBeNull();
    expect(nextStatus("payable", "issued", "clear")).toBeNull();
  });
});

describe("canonical instrument identity", () => {
  it("reads one cheque's serial the same however it was typed", () => {
    const canonical = canonicalSerialNumber("123456");
    for (const typed of ["۱۲۳۴۵۶", "١٢٣٤٥٦", " 123-456 ", "123/456", "123 456"]) {
      expect(canonicalSerialNumber(typed)).toBe(canonical);
    }
  });

  it("keeps genuinely different serials apart", () => {
    expect(canonicalSerialNumber("123456")).not.toBe(canonicalSerialNumber("123457"));
    expect(canonicalSerialNumber("A-123")).not.toBe(canonicalSerialNumber("B-123"));
  });

  it("treats «بانک ملت» and «ملت» as one bank", () => {
    const mellat = canonicalBankName("ملت");
    expect(canonicalBankName("بانک ملت")).toBe(mellat);
    expect(canonicalBankName("  ملت ")).toBe(mellat);
    expect(canonicalBankName("بانک  ملت")).toBe(mellat);
  });

  it("does not collapse two different banks, and keeps «بانک» inside a name", () => {
    expect(canonicalBankName("ملی")).not.toBe(canonicalBankName("ملت"));
    expect(canonicalBankName("بانک خاورمیانه")).toBe(canonicalBankName("خاورمیانه"));
  });

  it("folds the Arabic ي/ك a Persian keyboard produces by accident", () => {
    expect(canonicalBankName("ملي")).toBe(canonicalBankName("ملی"));
    expect(canonicalBankName("بانك ملت")).toBe(canonicalBankName("بانک ملت"));
  });
});

describe("returned cheques get a resolution", () => {
  it("lets a returned receivable be settled another way or put back on the customer", () => {
    expect(nextStatus("receivable", "bounced", "settle")).toBe("cleared");
    expect(nextStatus("receivable", "bounced", "restore")).toBe("resolved");
  });

  it("lets a returned payable be paid or put back on the supplier", () => {
    expect(nextStatus("payable", "bounced", "settle")).toBe("cleared");
    expect(nextStatus("payable", "bounced", "restore")).toBe("resolved");
  });

  it("never loops a returned cheque back into circulation", () => {
    for (const direction of CHEQUE_DIRECTIONS) {
      for (const action of ["deposit", "endorse", "clear", "present", "cancel", "bounce"] as const) {
        expect(nextStatus(direction, "bounced", action)).toBeNull();
      }
    }
  });

  it("offers exactly the two resolutions, and nothing after them", () => {
    expect(availableActions("receivable", "bounced")).toEqual(["settle", "restore"]);
    expect(availableActions("payable", "bounced")).toEqual(["settle", "restore"]);
    expect(isTerminal("receivable", "bounced")).toBe(false);
    expect(isTerminal("payable", "resolved")).toBe(true);
    expect(isTerminal("receivable", "resolved")).toBe(true);
  });
});

describe("terminal states", () => {
  it("ends a cheque's life at cleared, cancelled and resolved — but not at a bounce", () => {
    for (const direction of CHEQUE_DIRECTIONS) {
      expect(isTerminal(direction, "cleared")).toBe(true);
      expect(isTerminal(direction, "resolved")).toBe(true);
      // A returned cheque still has a balance in 1244/2122 to move.
      expect(isTerminal(direction, "bounced")).toBe(false);
    }
    expect(isTerminal("payable", "cancelled")).toBe(true);
  });

  it("leaves nothing to do from a terminal state, in any direction, for any action", () => {
    const terminal: ChequeStatus[] = ["cleared", "cancelled", "resolved"];
    for (const direction of CHEQUE_DIRECTIONS) {
      for (const status of terminal) {
        expect(availableActions(direction, status)).toEqual([]);
        for (const action of CHEQUE_ACTIONS) {
          expect(nextStatus(direction, status, action)).toBeNull();
        }
      }
    }
  });

  it("does not treat a live cheque as terminal", () => {
    expect(isTerminal("receivable", "on_hand")).toBe(false);
    expect(isTerminal("receivable", "in_collection")).toBe(false);
    expect(isTerminal("receivable", "endorsed")).toBe(false);
    expect(isTerminal("payable", "issued")).toBe(false);
  });
});

describe("availableActions", () => {
  it("offers exactly what the register should show", () => {
    expect(availableActions("receivable", "on_hand")).toEqual(["deposit", "endorse", "bounce"]);
    expect(availableActions("receivable", "in_collection")).toEqual(["clear", "bounce"]);
    expect(availableActions("payable", "issued")).toEqual(["bounce", "present", "cancel"]);
  });

  it("never offers an action that leads nowhere", () => {
    for (const direction of CHEQUE_DIRECTIONS) {
      for (const status of ["on_hand", "in_collection", "endorsed", "issued"] as ChequeStatus[]) {
        for (const action of availableActions(direction, status)) {
          expect(nextStatus(direction, status, action)).not.toBeNull();
        }
      }
    }
  });

  it("gives a direction nothing from a status that belongs to the other one", () => {
    expect(availableActions("receivable", "issued")).toEqual([]);
    expect(availableActions("payable", "on_hand")).toEqual([]);
  });
});

describe("normalizeSayadId", () => {
  it("accepts exactly sixteen digits", () => {
    expect(normalizeSayadId("1234567890123456")).toBe("1234567890123456");
  });

  it("reads the Persian and Arabic digits printed on a real cheque", () => {
    expect(normalizeSayadId("۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶")).toBe("1234567890123456");
    expect(normalizeSayadId("١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦")).toBe("1234567890123456");
  });

  it("ignores the spacing a counter types", () => {
    expect(normalizeSayadId("  1234 5678 9012 3456  ")).toBe("1234567890123456");
    expect(normalizeSayadId("1234-5678-9012-3456")).toBe("1234567890123456");
  });

  it("rejects anything that isn't sixteen digits", () => {
    expect(normalizeSayadId("123456789012345")).toBeNull();
    expect(normalizeSayadId("12345678901234567")).toBeNull();
    expect(normalizeSayadId("")).toBeNull();
    expect(normalizeSayadId("12345678901234ab")).toBeNull();
  });
});

describe("bucketChequesByDueDate", () => {
  it("puts a cheque not yet due in the current bucket rather than a negative one", () => {
    const buckets = bucketChequesByDueDate(
      [{ id: "a", dueDate: "2026-09-01", amount: 1_000_000 }],
      "2026-08-18",
    );
    expect(buckets).toEqual([{ bucket: "current", count: 1, total: 1_000_000 }]);
  });

  it("ages an overdue cheque into the same buckets AR and AP use", () => {
    const buckets = bucketChequesByDueDate(
      [
        { id: "a", dueDate: "2026-08-01", amount: 100 }, // 17 days
        { id: "b", dueDate: "2026-07-01", amount: 200 }, // 48 days
        { id: "c", dueDate: "2026-06-01", amount: 300 }, // 78 days
        { id: "d", dueDate: "2026-01-01", amount: 400 }, // 229 days
      ],
      "2026-08-18",
    );
    const byBucket = Object.fromEntries(buckets.map((b) => [b.bucket, b.total]));
    expect(byBucket).toEqual({ current: 100, d31_60: 200, d61_90: 300, over90: 400 });
  });

  it("sums several cheques landing in one bucket", () => {
    const buckets = bucketChequesByDueDate(
      [
        { id: "a", dueDate: "2026-08-10", amount: 100 },
        { id: "b", dueDate: "2026-08-12", amount: 250 },
      ],
      "2026-08-18",
    );
    expect(buckets).toEqual([{ bucket: "current", count: 2, total: 350 }]);
  });

  it("returns nothing for nothing", () => {
    expect(bucketChequesByDueDate([], "2026-08-18")).toEqual([]);
  });
});
