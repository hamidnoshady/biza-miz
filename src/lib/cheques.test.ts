import { describe, expect, it } from "vitest";
import {
  availableActions,
  chequeDuePosture,
  CHEQUE_DUE_SOON_DAYS,
  CHEQUE_OUTSTANDING_STATUSES,
  daysUntilDue,
  canonicalBankName,
  canonicalSerialNumber,
  CHEQUE_ACTIONS,
  CHEQUE_DIRECTIONS,
  CHEQUE_STATUSES,
  CHEQUE_TERMINAL_STATUSES,
  escapeLikePattern,
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

  it("reads a group separator inside a serial as formatting, not identity", () => {
    // A serial number is a label: nothing is ever computed from it, so a
    // thousands separator inside one can only be how it was typed. Persian
    // input produces «٬» (U+066C) most often, but «٫» (U+066B), the Arabic
    // comma «،» (U+060C) and a Latin comma all turn up on the same paper.
    const canonical = canonicalSerialNumber("123456");
    for (const typed of ["۱۲۳٬۴۵۶", "۱۲۳٫۴۵۶", "۱۲۳،۴۵۶", "123,456", " 123٬456 "]) {
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

describe("CHEQUE_TERMINAL_STATUSES", () => {
  it("is exactly the statuses no action can leave, in either direction", () => {
    expect([...CHEQUE_TERMINAL_STATUSES]).toEqual(["cleared", "cancelled", "resolved"]);
  });

  it("matches isTerminal in the direction that holds each status", () => {
    expect(isTerminal("receivable", "cleared")).toBe(true);
    expect(isTerminal("receivable", "resolved")).toBe(true);
    expect(isTerminal("payable", "cancelled")).toBe(true);
    expect(isTerminal("payable", "resolved")).toBe(true);
    // Live or returned balances are still open: they have an action to take.
    expect(isTerminal("receivable", "bounced")).toBe(false);
    expect(isTerminal("payable", "bounced")).toBe(false);
    expect(isTerminal("receivable", "endorsed")).toBe(false);
    expect(isTerminal("payable", "issued")).toBe(false);
    expect(isTerminal("receivable", "on_hand")).toBe(false);
  });
});

describe("escapeLikePattern", () => {
  it("escapes the LIKE wildcards and the escape character itself", () => {
    expect(escapeLikePattern("50%_off")).toBe("50\\%\\_off");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text, Persian text and digits untouched", () => {
    expect(escapeLikePattern("ملت ۱۲۳")).toBe("ملت ۱۲۳");
  });
});

describe("chequeDuePosture — the one due-date policy (issue #828, item 9)", () => {
  const ASOF = "2026-03-10";
  const at = (days: number) =>
    new Date(Date.parse(`${ASOF}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  it("only outstanding statuses can be overdue or due soon", () => {
    expect([...CHEQUE_OUTSTANDING_STATUSES].sort()).toEqual([
      "in_collection",
      "issued",
      "on_hand",
    ]);
  });

  /**
   * Every status against every due-date offset that matters: long past, the
   * day before, the due day itself, the last day of the window, the first day
   * outside it, and far in the future. A resolved cheque is never urgent, however
   * late it is.
   */
  const offsets = [
    -400,
    -1,
    0,
    CHEQUE_DUE_SOON_DAYS,
    CHEQUE_DUE_SOON_DAYS + 1,
    400,
  ];
  const expected: Record<ChequeStatus, (days: number) => string> = {
    on_hand: (d) =>
      d < 0 ? "overdue" : d <= CHEQUE_DUE_SOON_DAYS ? "due_soon" : "due_later",
    in_collection: (d) =>
      d < 0 ? "overdue" : d <= CHEQUE_DUE_SOON_DAYS ? "due_soon" : "due_later",
    issued: (d) =>
      d < 0 ? "overdue" : d <= CHEQUE_DUE_SOON_DAYS ? "due_soon" : "due_later",
    endorsed: () => "contingent",
    bounced: () => "returned",
    cleared: () => "settled",
    cancelled: () => "settled",
    resolved: () => "settled",
  };

  for (const status of Object.keys(expected) as ChequeStatus[]) {
    it(`${status}: every date offset gets the posture the accounting position allows`, () => {
      for (const days of offsets) {
        expect(
          chequeDuePosture(status, at(days), ASOF),
          `${status} at ${days} days`,
        ).toBe(expected[status](days));
      }
    });
  }

  it("never gives a resolved, cleared or cancelled cheque outstanding urgency", () => {
    for (const status of ["resolved", "cleared", "cancelled"] as const) {
      for (const days of offsets) {
        expect(["overdue", "due_soon"]).not.toContain(
          chequeDuePosture(status, at(days), ASOF),
        );
      }
    }
  });

  it("keeps a bounced cheque returned, however far past its due date", () => {
    expect(chequeDuePosture("bounced", at(-400), ASOF)).toBe("returned");
  });

  it("calls an endorsed cheque contingent, never overdue", () => {
    expect(chequeDuePosture("endorsed", at(-400), ASOF)).toBe("contingent");
  });

  it("counts the due-soon window in whole days, inclusive at the edge", () => {
    expect(chequeDuePosture("issued", at(CHEQUE_DUE_SOON_DAYS), ASOF)).toBe(
      "due_soon",
    );
    expect(chequeDuePosture("issued", at(CHEQUE_DUE_SOON_DAYS + 1), ASOF)).toBe(
      "due_later",
    );
    expect(daysUntilDue(at(-1), ASOF)).toBe(-1);
  });

  it("uses calendar days, so a due date on the as-of day is not overdue", () => {
    expect(chequeDuePosture("on_hand", ASOF, ASOF)).toBe("due_soon");
  });
});
