/**
 * Issue #799 §18, §20, §22 and §24 — the procurement catalogue's pure contract.
 *
 * What needs no database is asserted here: §18's three chains and the two
 * deliberate reopenings, the quotation states, the arithmetic §20's committed
 * cost is built from (migration 0201's CHECKs repeat the same facts, so the two
 * must say one thing), the forecast's null-not-zero rule, and §24's split
 * between writing the register and obliging the business. The registers
 * themselves are covered in `integration/aec-procurement.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  COMMITMENT_ACTIONS,
  COMMITMENT_ACTION_EVENTS,
  COMMITMENT_ACTION_LABELS,
  COMMITMENT_ACTION_PAST_LABELS,
  COMMITMENT_ACTION_TARGET,
  COMMITMENT_CAPABILITY_FOR,
  COMMITMENT_KINDS,
  COMMITMENT_KIND_LABELS,
  COMMITMENT_NUMBER_PREFIX,
  COMMITMENT_STATUSES,
  COMMITMENT_STATUS_LABELS,
  FORECAST_BASIS_LABEL,
  MATERIAL_REQUEST_ACTIONS,
  MATERIAL_REQUEST_ACTION_EVENTS,
  MATERIAL_REQUEST_ACTION_LABELS,
  MATERIAL_REQUEST_ACTION_PAST_LABELS,
  MATERIAL_REQUEST_ACTION_TARGET,
  MATERIAL_REQUEST_PRIORITIES,
  MATERIAL_REQUEST_PRIORITY_LABELS,
  MATERIAL_REQUEST_STATUSES,
  MATERIAL_REQUEST_STATUS_LABELS,
  QUOTATION_ACTIONS,
  QUOTATION_ACTION_LABELS,
  QUOTATION_ACTION_TARGET,
  QUOTATION_STATUSES,
  QUOTATION_STATUS_LABELS,
  REQUEST_NUMBER_PREFIX,
  RFQ_ACTIONS,
  RFQ_ACTION_LABELS,
  RFQ_ACTION_TARGET,
  RFQ_NUMBER_PREFIX,
  RFQ_STATUSES,
  RFQ_STATUS_LABELS,
  canTransitionCommitment,
  canTransitionMaterialRequest,
  canTransitionQuotation,
  canTransitionRfq,
  commitmentActionNeedsApproval,
  commitmentDelayDays,
  commitmentTotals,
  costForecast,
  forecastMarginRial,
  isCommitmentAction,
  isCommitmentDelayed,
  isCommitmentKind,
  isCommitmentStatus,
  isEditableCommitment,
  isEditableMaterialRequest,
  isEditableRfq,
  isMaterialRequestAction,
  isMaterialRequestPriority,
  isOpenCommitment,
  isOpenMaterialRequest,
  isOpenRfq,
  isQuotationAction,
  isQuotationDecided,
  isQuotationStatus,
  isRfqAction,
  isRfqStatus,
  materialRequestActionNeedsApproval,
  quotationActionNeedsApproval,
  rfqActionNeedsApproval,
} from "./aec-procurement";

describe("§18's material-request chain", () => {
  it("carries the issue's statuses in its order", () => {
    expect([...MATERIAL_REQUEST_STATUSES]).toEqual([
      "draft",
      "submitted",
      "approved",
      "rejected",
      "closed",
      "cancelled",
    ]);
    for (const status of MATERIAL_REQUEST_STATUSES) {
      expect(isMaterialRequestStatusSafe(status)).toBe(true);
      expect(MATERIAL_REQUEST_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
  });

  it("moves draft → submitted → approved and stops there", () => {
    expect(canTransitionMaterialRequest("draft", "submitted")).toBe(true);
    expect(canTransitionMaterialRequest("submitted", "approved")).toBe(true);
    expect(canTransitionMaterialRequest("submitted", "rejected")).toBe(true);
    expect(canTransitionMaterialRequest("approved", "closed")).toBe(true);
    // A request nobody will buy is cancelled, never pushed backwards; the one
    // deliberate reopening goes through `rejected`.
    expect(canTransitionMaterialRequest("approved", "draft")).toBe(false);
    expect(canTransitionMaterialRequest("closed", "draft")).toBe(false);
    expect(canTransitionMaterialRequest("cancelled", "draft")).toBe(false);
    expect(canTransitionMaterialRequest("rejected", "draft")).toBe(true);
  });

  it("only lets a draft or rejected request be edited", () => {
    expect(isEditableMaterialRequest("draft")).toBe(true);
    expect(isEditableMaterialRequest("rejected")).toBe(true);
    for (const status of ["submitted", "approved", "closed", "cancelled"] as const) {
      expect(isEditableMaterialRequest(status), status).toBe(false);
    }
    expect(isOpenMaterialRequest("draft")).toBe(true);
    expect(isOpenMaterialRequest("submitted")).toBe(true);
    expect(isOpenMaterialRequest("approved")).toBe(true);
    expect(isOpenMaterialRequest("closed")).toBe(false);
    expect(isOpenMaterialRequest("cancelled")).toBe(false);
  });

  it("prices urgency in four steps and numbers requests `MR-`", () => {
    expect([...MATERIAL_REQUEST_PRIORITIES]).toEqual(["low", "normal", "high", "urgent"]);
    for (const priority of MATERIAL_REQUEST_PRIORITIES) {
      expect(MATERIAL_REQUEST_PRIORITY_LABELS[priority]?.trim().length, priority).toBeGreaterThan(0);
      expect(isMaterialRequestPriority(priority)).toBe(true);
    }
    expect(isMaterialRequestPriority("critical")).toBe(false);
    expect(REQUEST_NUMBER_PREFIX).toBe("MR");
  });

  it("asks for the approval key on approve and reject, and nothing else", () => {
    expect([...MATERIAL_REQUEST_ACTIONS]).toEqual([
      "submit",
      "approve",
      "reject",
      "close",
      "cancel",
      "reopen",
    ]);
    for (const action of MATERIAL_REQUEST_ACTIONS) {
      expect(isMaterialRequestAction(action)).toBe(true);
      expect(MATERIAL_REQUEST_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(MATERIAL_REQUEST_ACTION_PAST_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(MATERIAL_REQUEST_ACTION_EVENTS[action]?.trim().length, action).toBeGreaterThan(0);
      expect([...MATERIAL_REQUEST_STATUSES]).toContain(MATERIAL_REQUEST_ACTION_TARGET[action]);
    }
    for (const action of ["submit", "close", "cancel", "reopen"] as const) {
      expect(materialRequestActionNeedsApproval(action), action).toBe(false);
    }
    for (const action of ["approve", "reject"] as const) {
      expect(materialRequestActionNeedsApproval(action), action).toBe(true);
    }
    expect(isMaterialRequestAction("certify")).toBe(false);
  });
});

describe("§18's RFQ and its quotations", () => {
  it("freezes a tender that has been issued", () => {
    expect([...RFQ_STATUSES]).toEqual(["draft", "issued", "closed", "cancelled"]);
    for (const status of RFQ_STATUSES) {
      expect(isRfqStatus(status)).toBe(true);
      expect(RFQ_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
    expect(canTransitionRfq("draft", "issued")).toBe(true);
    expect(canTransitionRfq("issued", "closed")).toBe(true);
    expect(canTransitionRfq("issued", "draft")).toBe(false);
    expect(canTransitionRfq("closed", "issued")).toBe(false);
    expect(isEditableRfq("draft")).toBe(true);
    expect(isEditableRfq("issued")).toBe(false);
    expect(isOpenRfq("issued")).toBe(true);
    expect(isOpenRfq("closed")).toBe(false);
    expect(RFQ_NUMBER_PREFIX).toBe("RFQ");

    expect([...RFQ_ACTIONS]).toEqual(["issue", "close", "cancel"]);
    for (const action of RFQ_ACTIONS) {
      expect(isRfqAction(action)).toBe(true);
      expect(RFQ_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect([...RFQ_STATUSES]).toContain(RFQ_ACTION_TARGET[action]);
    }
    // Asking for prices commits nothing — §24's approval sits on the award.
    expect(rfqActionNeedsApproval()).toBe(false);
    expect(quotationActionNeedsApproval()).toBe(false);
    expect(isRfqAction("approve")).toBe(false);
  });

  it("keeps one honest offer per supplier and freezes a decided one", () => {
    expect([...QUOTATION_STATUSES]).toEqual(["received", "shortlisted", "selected", "declined"]);
    for (const status of QUOTATION_STATUSES) {
      expect(isQuotationStatus(status)).toBe(true);
      expect(QUOTATION_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
    expect(canTransitionQuotation("received", "shortlisted")).toBe(true);
    expect(canTransitionQuotation("shortlisted", "selected")).toBe(true);
    expect(canTransitionQuotation("declined", "received")).toBe(true);
    // The award was raised from a selected offer; it is history.
    expect(canTransitionQuotation("selected", "declined")).toBe(false);
    expect(isQuotationDecided("received")).toBe(false);
    for (const status of ["shortlisted", "selected", "declined"] as const) {
      expect(isQuotationDecided(status), status).toBe(true);
    }
    expect([...QUOTATION_ACTIONS]).toEqual(["shortlist", "select", "decline", "reconsider"]);
    for (const action of QUOTATION_ACTIONS) {
      expect(isQuotationAction(action)).toBe(true);
      expect(QUOTATION_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect([...QUOTATION_STATUSES]).toContain(QUOTATION_ACTION_TARGET[action]);
    }
  });
});

describe("§18's commitment", () => {
  it("numbers a purchase `PO-` and a subcontract `SC-`", () => {
    expect([...COMMITMENT_KINDS]).toEqual(["purchase", "subcontract"]);
    for (const kind of COMMITMENT_KINDS) {
      expect(isCommitmentKind(kind)).toBe(true);
      expect(COMMITMENT_KIND_LABELS[kind]?.trim().length, kind).toBeGreaterThan(0);
      expect(COMMITMENT_NUMBER_PREFIX[kind]?.trim().length, kind).toBeGreaterThan(0);
    }
    expect(COMMITMENT_NUMBER_PREFIX.purchase).toBe("PO");
    expect(COMMITMENT_NUMBER_PREFIX.subcontract).toBe("SC");
    expect(isCommitmentKind("consultancy")).toBe(false);
  });

  it("switches a subcontract on its own capability, not the register's", () => {
    // §18 lets a small office run purchases without subcontract packages:
    // `procurement` is the register, `subcontractors` gates the SC kind.
    expect(COMMITMENT_CAPABILITY_FOR).toEqual({
      purchase: "procurement",
      subcontract: "subcontractors",
    });
  });

  it("carries the issue's statuses and freezes a submitted award", () => {
    expect([...COMMITMENT_STATUSES]).toEqual([
      "draft",
      "submitted",
      "approved",
      "rejected",
      "delivered",
      "closed",
      "cancelled",
    ]);
    for (const status of COMMITMENT_STATUSES) {
      expect(isCommitmentStatus(status)).toBe(true);
      expect(COMMITMENT_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
    expect(canTransitionCommitment("draft", "submitted")).toBe(true);
    expect(canTransitionCommitment("submitted", "approved")).toBe(true);
    expect(canTransitionCommitment("approved", "delivered")).toBe(true);
    expect(canTransitionCommitment("delivered", "closed")).toBe(true);
    expect(canTransitionCommitment("rejected", "draft")).toBe(true);
    // No path back into an award that has been decided: reopening an approved
    // commitment would move money the approver already agreed to.
    expect(canTransitionCommitment("approved", "draft")).toBe(false);
    expect(canTransitionCommitment("delivered", "approved")).toBe(false);
    expect(canTransitionCommitment("cancelled", "draft")).toBe(false);
    expect(isEditableCommitment("draft")).toBe(true);
    expect(isEditableCommitment("rejected")).toBe(true);
    expect(isEditableCommitment("submitted")).toBe(false);
    expect(isOpenCommitment("approved")).toBe(true);
    expect(isOpenCommitment("delivered")).toBe(false);
  });

  it("asks for the approval key on approve, reject and cancel", () => {
    expect([...COMMITMENT_ACTIONS]).toEqual([
      "submit",
      "approve",
      "reject",
      "deliver",
      "close",
      "cancel",
      "reopen",
    ]);
    for (const action of COMMITMENT_ACTIONS) {
      expect(isCommitmentAction(action)).toBe(true);
      expect(COMMITMENT_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(COMMITMENT_ACTION_PAST_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(COMMITMENT_ACTION_EVENTS[action]?.trim().length, action).toBeGreaterThan(0);
      expect([...COMMITMENT_STATUSES]).toContain(COMMITMENT_ACTION_TARGET[action]);
    }
    for (const action of ["submit", "deliver", "close", "reopen"] as const) {
      expect(commitmentActionNeedsApproval(action), action).toBe(false);
    }
    for (const action of ["approve", "reject", "cancel"] as const) {
      expect(commitmentActionNeedsApproval(action), action).toBe(true);
    }
    expect(isCommitmentAction("issue")).toBe(false);
  });
});

describe("§20's committed cost and §18's delay warning", () => {
  const rows = [
    { status: "draft" as const, valueRial: 100, expectedDeliveryDate: "2026-01-01" },
    { status: "submitted" as const, valueRial: 200, expectedDeliveryDate: "2026-01-01" },
    { status: "rejected" as const, valueRial: 400, expectedDeliveryDate: "2026-01-01" },
    { status: "approved" as const, valueRial: 1_000, expectedDeliveryDate: "2026-01-01" },
    { status: "approved" as const, valueRial: 2_000, expectedDeliveryDate: "2026-06-01" },
    { status: "delivered" as const, valueRial: 500, expectedDeliveryDate: "2026-01-01" },
    // Closed: the cost is the ledger's now, so counting it here would
    // double-count the same rial.
    { status: "closed" as const, valueRial: 8_000, expectedDeliveryDate: "2026-01-01" },
    { status: "cancelled" as const, valueRial: 9_000, expectedDeliveryDate: "2026-01-01" },
  ];

  it("counts what is committed, what arrived, and what is late", () => {
    const totals = commitmentTotals(rows, "2026-03-01");
    expect(totals.committedRial).toBe(3_500);
    expect(totals.deliveredRial).toBe(500);
    // Only the *approved* late award is a delay: a delivered one has arrived.
    expect(totals.delayedCount).toBe(1);
    expect(totals.delayedRial).toBe(1_000);
  });

  it("treats a missing date as no promise and the due day as not late", () => {
    expect(commitmentDelayDays(null, "2026-03-01")).toBeNull();
    expect(commitmentDelayDays("", "2026-03-01")).toBeNull();
    expect(commitmentDelayDays("2026-03-01", "2026-03-01")).toBe(0);
    expect(commitmentDelayDays("2026-03-10", "2026-03-01")).toBe(-9);
    expect(commitmentDelayDays("2026-02-20", "2026-03-01")).toBe(9);

    expect(isCommitmentDelayed({ status: "approved", expectedDeliveryDate: "2026-02-20" }, "2026-03-01")).toBe(true);
    expect(isCommitmentDelayed({ status: "approved", expectedDeliveryDate: "2026-03-01" }, "2026-03-01")).toBe(false);
    expect(isCommitmentDelayed({ status: "approved", expectedDeliveryDate: null }, "2026-03-01")).toBe(false);
    // A draft is not late — it is a decision nobody has taken yet.
    expect(isCommitmentDelayed({ status: "draft", expectedDeliveryDate: "2026-01-01" }, "2026-03-01")).toBe(false);
    expect(isCommitmentDelayed({ status: "delivered", expectedDeliveryDate: "2026-01-01" }, "2026-03-01")).toBe(false);
  });

  it("forecasts only from both halves, and never reports zero for unknown", () => {
    expect(costForecast({ actualCostRial: null, committedRial: 100, approvedEstimateRial: 1_000 })).toBeNull();
    expect(costForecast({ actualCostRial: 100, committedRial: 0, approvedEstimateRial: null })).toBeNull();

    const forecast = costForecast({
      actualCostRial: 2_000,
      committedRial: 500,
      approvedEstimateRial: 5_000,
    });
    expect(forecast).toEqual({ costToCompleteRial: 2_500, forecastFinalCostRial: 5_000 });

    // An estimate already spent out leaves nothing to complete, not a negative
    // number that would then subtract from the final cost.
    expect(
      costForecast({ actualCostRial: 6_000, committedRial: 1_000, approvedEstimateRial: 5_000 }),
    ).toEqual({ costToCompleteRial: 0, forecastFinalCostRial: 7_000 });

    // §20's margin is a forecast and says so; without a forecast it is null.
    expect(forecastMarginRial(9_000, 5_000)).toBe(4_000);
    expect(forecastMarginRial(9_000, null)).toBeNull();
    expect(FORECAST_BASIS_LABEL.trim().length).toBeGreaterThan(0);
  });
});

/** Kept as a local so the loop above reads as one assertion, not a cast. */
function isMaterialRequestStatusSafe(status: string): boolean {
  return (MATERIAL_REQUEST_STATUSES as readonly string[]).includes(status);
}
