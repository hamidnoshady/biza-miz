/**
 * Issue #866 — the taxpayer record's lifecycle, as the client and the service
 * both read it. Pure: no database, no network. What is pinned here is the set of
 * legal moves, because every other rule (the worker, the retry policy, the
 * database trigger) is written against it.
 */
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  availableTaxActions,
  canTransition,
  isLiveStatus,
  statusesForView,
  TAX_ITEM_CODE_PATTERN,
  TAX_REFERENCE_PATTERN,
  TAX_STATUS_LABELS,
  TAX_STATUS_TRANSITIONS,
  TAX_STATUSES,
  TAX_UID_PATTERN,
  TaxTransitionError,
  taxStatusTone,
  viewForStatus,
  type TaxStatus,
} from "./tax-invoice";

describe("status vocabulary", () => {
  it("has a label and a transition row for every status, and nothing extra", () => {
    expect(Object.keys(TAX_STATUS_LABELS).sort()).toEqual([...TAX_STATUSES].sort());
    expect(Object.keys(TAX_STATUS_TRANSITIONS).sort()).toEqual([...TAX_STATUSES].sort());
  });

  it("never offers a transition to a status outside the vocabulary", () => {
    const known = new Set<string>(TAX_STATUSES);
    for (const moves of Object.values(TAX_STATUS_TRANSITIONS)) {
      for (const to of moves) expect(known.has(to)).toBe(true);
    }
  });
});

describe("legal moves", () => {
  it("walks the happy path from preparation to acceptance", () => {
    const path: TaxStatus[] = ["prepared", "queued", "sending", "submitted", "accepted"];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("sends an ambiguous timeout to inquiry, never straight back to the queue", () => {
    expect(canTransition("sending", "awaiting_inquiry")).toBe(true);
    expect(canTransition("sending", "queued")).toBe(true); // certainly not delivered
    expect(canTransition("awaiting_inquiry", "queued")).toBe(true); // the authority said: never received
    expect(canTransition("submitted", "queued")).toBe(false); // a submitted record is never resent
  });

  it("refuses a skip over the queue or the send", () => {
    expect(canTransition("prepared", "accepted")).toBe(false);
    expect(canTransition("prepared", "sending")).toBe(false);
    expect(canTransition("queued", "accepted")).toBe(false);
  });

  it("leaves rejected and cancelled as terminal states", () => {
    expect(TAX_STATUS_TRANSITIONS.rejected).toEqual([]);
    expect(TAX_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  it("lets an error be retried and only retried", () => {
    expect(TAX_STATUS_TRANSITIONS.error).toEqual(["queued"]);
  });

  it("allows an accepted record to be cancelled but never to go back", () => {
    expect(canTransition("accepted", "cancelled")).toBe(true);
    expect(canTransition("accepted", "submitted")).toBe(false);
    expect(canTransition("accepted", "rejected")).toBe(false);
  });

  it("throws a typed error with a stable code for an illegal move", () => {
    expect(() => assertTransition("prepared", "accepted")).toThrow(TaxTransitionError);
    try {
      assertTransition("rejected", "queued");
      expect.unreachable("an illegal move must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaxTransitionError);
      expect((error as TaxTransitionError).code).toBe("tax_invalid_transition");
      expect((error as TaxTransitionError).from).toBe("rejected");
      expect((error as TaxTransitionError).to).toBe("queued");
    }
  });

  it("accepts every move the table lists", () => {
    for (const from of TAX_STATUSES) {
      for (const to of TAX_STATUS_TRANSITIONS[from]) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });
});

describe("live records", () => {
  it("treats only rejected and cancelled records as no longer standing", () => {
    for (const status of TAX_STATUSES) {
      expect(isLiveStatus(status), status).toBe(status !== "rejected" && status !== "cancelled");
    }
  });

  it("keeps an error record live, so a sale with one still counts as reported", () => {
    expect(isLiveStatus("error")).toBe(true);
  });
});

describe("views", () => {
  it("places each status in exactly one of the three views", () => {
    for (const status of TAX_STATUSES) {
      const views = (["unsent", "sent", "error"] as const).filter((view) => statusesForView(view).includes(status));
      expect(views, status).toHaveLength(1);
      expect(viewForStatus(status)).toBe(views[0]);
    }
  });

  it("puts unsent work, sent work and failures where an operator would look for them", () => {
    expect(viewForStatus("prepared")).toBe("unsent");
    expect(viewForStatus("queued")).toBe("unsent");
    expect(viewForStatus("awaiting_inquiry")).toBe("sent");
    expect(viewForStatus("accepted")).toBe("sent");
    expect(viewForStatus("error")).toBe("error");
    expect(viewForStatus("rejected")).toBe("error");
  });
});

describe("actions offered on a record", () => {
  it("offers a send only before the record leaves the preparation", () => {
    expect(availableTaxActions({ status: "prepared", kind: "sale" })).toEqual(["send"]);
  });

  it("offers an inquiry, and never a resend, while the outcome is unknown", () => {
    expect(availableTaxActions({ status: "submitted", kind: "sale" })).toEqual(["inquire"]);
    expect(availableTaxActions({ status: "awaiting_inquiry", kind: "sale" })).toEqual(["inquire"]);
  });

  it("offers a retry for an error and a fresh revision for a rejection", () => {
    expect(availableTaxActions({ status: "error", kind: "sale" })).toEqual(["retry"]);
    expect(availableTaxActions({ status: "rejected", kind: "sale" })).toEqual(["resubmit"]);
  });

  it("lets an accepted sale be amended or cancelled", () => {
    expect(availableTaxActions({ status: "accepted", kind: "sale" })).toEqual(["amend", "cancel"]);
  });

  it("lets an accepted amendment be amended, but not cancelled on its own", () => {
    expect(availableTaxActions({ status: "accepted", kind: "amendment" })).toEqual(["amend"]);
  });

  it("offers nothing on an accepted cancellation, which is final", () => {
    expect(availableTaxActions({ status: "accepted", kind: "cancellation" })).toEqual([]);
  });

  it("offers nothing while a worker holds the record", () => {
    expect(availableTaxActions({ status: "queued", kind: "sale" })).toEqual([]);
    expect(availableTaxActions({ status: "sending", kind: "sale" })).toEqual([]);
    expect(availableTaxActions({ status: "cancelled", kind: "sale" })).toEqual([]);
  });
});

describe("tone", () => {
  it("colours acceptance green, failures red, work in progress amber", () => {
    expect(taxStatusTone("accepted")).toBe("positive");
    expect(taxStatusTone("error")).toBe("danger");
    expect(taxStatusTone("rejected")).toBe("danger");
    expect(taxStatusTone("awaiting_inquiry")).toBe("active");
    expect(taxStatusTone("prepared")).toBe("neutral");
  });
});

describe("identifier shapes", () => {
  it("accepts only a thirteen-digit item code", () => {
    expect(TAX_ITEM_CODE_PATTERN.test("1234567890123")).toBe(true);
    expect(TAX_ITEM_CODE_PATTERN.test("123456789012")).toBe(false);
    expect(TAX_ITEM_CODE_PATTERN.test("12345678901234")).toBe(false);
    expect(TAX_ITEM_CODE_PATTERN.test("12345678901a3")).toBe(false);
  });

  it("accepts a lower-case uuid as the record uid and nothing looser", () => {
    expect(TAX_UID_PATTERN.test("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
    expect(TAX_UID_PATTERN.test("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe(false);
    expect(TAX_UID_PATTERN.test("not-a-uid")).toBe(false);
  });

  it("keeps reference numbers to letters, digits and dashes, up to sixty-four", () => {
    expect(TAX_REFERENCE_PATTERN.test("BIZ-K1-1042-S1")).toBe(true);
    expect(TAX_REFERENCE_PATTERN.test("BIZ K1")).toBe(false);
    expect(TAX_REFERENCE_PATTERN.test("A".repeat(64))).toBe(true);
    expect(TAX_REFERENCE_PATTERN.test("A".repeat(65))).toBe(false);
  });
});
