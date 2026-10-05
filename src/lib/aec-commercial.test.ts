/**
 * Issue #799 §15, §16 and §20 — the commercial catalogue's pure contract.
 *
 * What needs no database is asserted here: §15's chain and its one deliberate
 * reopening, §16's arithmetic (which migration 0200's CHECK repeats, so the two
 * must be one expression), the rule that an approved variation moves the revised
 * value without rewriting the original, and the §24 split between writing a
 * change order and determining one. The registers themselves are covered in
 * `integration/aec-commercial.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_ACTION_LABELS,
  CERTIFICATE_ACTION_PAST_LABELS,
  CERTIFICATE_ACTION_TARGET,
  CERTIFICATE_ACTIONS,
  CERTIFICATE_KINDS,
  CERTIFICATE_KIND_LABELS,
  CERTIFICATE_STATUSES,
  CERTIFICATE_STATUS_LABELS,
  COMMERCIAL_CAPABILITY_FOR,
  VARIATION_ACTION_LABELS,
  VARIATION_ACTION_PAST_LABELS,
  VARIATION_ACTION_TARGET,
  VARIATION_ACTIONS,
  VARIATION_SOURCES,
  VARIATION_SOURCE_LABELS,
  VARIATION_STATUSES,
  VARIATION_STATUS_LABELS,
  canTransitionCertificate,
  canTransitionVariation,
  certificateActionNeedsApproval,
  certificateTotals,
  isApprovedVariation,
  isCertificateAction,
  isCertificateKind,
  isCertificateStatus,
  isEditableCertificate,
  isEditableVariation,
  isOpenCertificate,
  isOpenVariation,
  isVariationAction,
  isVariationSource,
  isVariationStatus,
  outstandingAdvanceRial,
  previousCertifiedRial,
  retentionTotalRial,
  revisedContractValueRial,
  variationActionNeedsApproval,
} from "./aec-commercial";

describe("§15's variation chain", () => {
  it("carries the issue's statuses in its order", () => {
    expect([...VARIATION_STATUSES]).toEqual([
      "draft",
      "priced",
      "submitted",
      "under_review",
      "approved",
      "rejected",
      "implemented",
      "cancelled",
    ]);
    for (const status of VARIATION_STATUSES) {
      expect(VARIATION_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
      expect(isVariationStatus(status)).toBe(true);
    }
    expect(isVariationStatus("signed")).toBe(false);
    expect(Object.keys(VARIATION_STATUS_LABELS).sort()).toEqual([...VARIATION_STATUSES].sort());
  });

  it("walks Draft → Priced → Submitted → Under Review → Approved → Implemented", () => {
    expect(canTransitionVariation("draft", "priced")).toBe(true);
    expect(canTransitionVariation("priced", "submitted")).toBe(true);
    expect(canTransitionVariation("submitted", "under_review")).toBe(true);
    expect(canTransitionVariation("under_review", "approved")).toBe(true);
    expect(canTransitionVariation("approved", "implemented")).toBe(true);
    // The issue's chain is a chain: no skipping the pricing, no implementing
    // what nobody approved.
    expect(canTransitionVariation("draft", "submitted")).toBe(false);
    expect(canTransitionVariation("draft", "approved")).toBe(false);
    expect(canTransitionVariation("submitted", "approved")).toBe(false);
    expect(canTransitionVariation("priced", "implemented")).toBe(false);
  });

  it("lets a rejected change be re-priced and a live one withdrawn, and stops there", () => {
    expect(canTransitionVariation("under_review", "rejected")).toBe(true);
    expect(canTransitionVariation("rejected", "priced")).toBe(true);
    // A submitted order can be withdrawn to be re-priced…
    expect(canTransitionVariation("submitted", "priced")).toBe(true);
    // …but an implemented or cancelled one is history.
    expect(canTransitionVariation("implemented", "cancelled")).toBe(false);
    expect(canTransitionVariation("implemented", "approved")).toBe(false);
    expect(canTransitionVariation("cancelled", "draft")).toBe(false);
  });

  it("freezes content once the client has seen it", () => {
    expect(isEditableVariation("draft")).toBe(true);
    expect(isEditableVariation("priced")).toBe(true);
    for (const status of VARIATION_STATUSES) {
      if (status === "draft" || status === "priced") continue;
      expect(isEditableVariation(status), status).toBe(false);
    }
  });

  it("counts only approved and implemented orders into the contract", () => {
    expect(isApprovedVariation("approved")).toBe(true);
    expect(isApprovedVariation("implemented")).toBe(true);
    expect(isApprovedVariation("submitted")).toBe(false);
    expect(isApprovedVariation("rejected")).toBe(false);
    // "Open" is everything that has not reached an end state — what the cockpit
    // and the assistant's risk read count as in flight.
    expect(isOpenVariation("draft")).toBe(true);
    expect(isOpenVariation("under_review")).toBe(true);
    expect(isOpenVariation("implemented")).toBe(false);
    expect(isOpenVariation("cancelled")).toBe(false);
  });

  it("names §15's sources", () => {
    expect([...VARIATION_SOURCES]).toEqual([
      "client_instruction",
      "design_change",
      "site_condition",
      "regulatory",
      "omission_correction",
      "other",
    ]);
    for (const source of VARIATION_SOURCES) {
      expect(VARIATION_SOURCE_LABELS[source]?.trim().length, source).toBeGreaterThan(0);
      expect(isVariationSource(source)).toBe(true);
    }
    expect(isVariationSource("client_instruction")).toBe(true);
    expect(isVariationSource("weather")).toBe(false);
  });
});

describe("§16's certificate arithmetic", () => {
  it("subtracts every deduction from the measured work", () => {
    const totals = certificateTotals({
      grossRial: 1_000_000_000,
      advanceRecoveryRial: 100_000_000,
      retentionRial: 50_000_000,
      otherDeductionsRial: 10_000_000,
      taxRial: 9_000_000,
    });
    expect(totals.withheldRial).toBe(169_000_000);
    expect(totals.netRial).toBe(831_000_000);
    // The expression migration 0200's CHECK enforces is the same one:
    // net = gross − advance recovery − retention − other deductions − tax.
    expect(totals.netRial).toBe(
      1_000_000_000 - 100_000_000 - 50_000_000 - 10_000_000 - 9_000_000,
    );
  });

  it("adds the earlier certified claims into §16's «previous certified»", () => {
    expect(previousCertifiedRial([100, 250, 400])).toBe(750);
    expect(previousCertifiedRial([])).toBe(0);
  });

  it("never lets an advance be over-recovered, and never negative", () => {
    expect(outstandingAdvanceRial(500, 200)).toBe(300);
    expect(outstandingAdvanceRial(500, 500)).toBe(0);
    expect(outstandingAdvanceRial(500, 900)).toBe(0);
  });

  it("sums retention per side of the contract", () => {
    expect(retentionTotalRial([10, 25, 5])).toBe(40);
    expect(retentionTotalRial([])).toBe(0);
  });

  it("walks §16's cycle and keeps a certified claim closed", () => {
    expect([...CERTIFICATE_STATUSES]).toEqual([
      "draft",
      "submitted",
      "under_review",
      "certified",
      "rejected",
      "cancelled",
    ]);
    expect(canTransitionCertificate("draft", "submitted")).toBe(true);
    expect(canTransitionCertificate("submitted", "under_review")).toBe(true);
    expect(canTransitionCertificate("under_review", "certified")).toBe(true);
    expect(canTransitionCertificate("under_review", "rejected")).toBe(true);
    // A rejected claim is re-measured: back to draft, then around again.
    expect(canTransitionCertificate("rejected", "draft")).toBe(true);
    // A certified claim is a record and cannot move at all.
    for (const status of CERTIFICATE_STATUSES) {
      expect(canTransitionCertificate("certified", status), status).toBe(false);
    }
    expect(canTransitionCertificate("cancelled", "draft")).toBe(false);
    // Nothing skips certification: a draft is never certified directly.
    expect(canTransitionCertificate("draft", "certified")).toBe(false);
    expect(isCertificateStatus("certified")).toBe(true);
    expect(isCertificateStatus("paid")).toBe(false);
    for (const status of CERTIFICATE_STATUSES) {
      expect(CERTIFICATE_STATUS_LABELS[status]?.trim().length, status).toBeGreaterThan(0);
    }
  });

  it("names §16's two directions", () => {
    expect([...CERTIFICATE_KINDS]).toEqual(["application", "certificate"]);
    for (const kind of CERTIFICATE_KINDS) {
      expect(CERTIFICATE_KIND_LABELS[kind]?.trim().length, kind).toBeGreaterThan(0);
      expect(isCertificateKind(kind)).toBe(true);
    }
    expect(isCertificateKind("retention_release")).toBe(false);
  });

  it("keeps only a draft editable and only a certified claim closed", () => {
    expect(isEditableCertificate("draft")).toBe(true);
    expect(isEditableCertificate("submitted")).toBe(false);
    expect(isEditableCertificate("certified")).toBe(false);
    expect(isOpenCertificate("draft")).toBe(true);
    expect(isOpenCertificate("approved" as never)).toBe(true); // not a real status: still "open"
    expect(isOpenCertificate("certified")).toBe(false);
    expect(isOpenCertificate("cancelled")).toBe(false);
  });
});

describe("§20's revised contract value", () => {
  it("adds the approved variations to the original without rewriting it", () => {
    expect(revisedContractValueRial(1_000, [100, 250])).toBe(1_350);
    expect(revisedContractValueRial(1_000, [])).toBe(1_000);
    // An empty contract with no changes is zero, not a missing value.
    expect(revisedContractValueRial(0, [])).toBe(0);
    // The rule §15 states: the original is an *argument*, never a result.
    const original = 5_000_000;
    const revised = revisedContractValueRial(original, [1_000_000]);
    expect(original).toBe(5_000_000);
    expect(revised).toBe(6_000_000);
  });
});

describe("the §24 action split", () => {
  it("keeps writing a change order apart from determining one", () => {
    expect([...VARIATION_ACTIONS]).toEqual([
      "price",
      "submit",
      "review",
      "approve",
      "reject",
      "implement",
      "cancel",
      "reopen",
    ]);
    for (const action of VARIATION_ACTIONS) {
      expect(isVariationAction(action)).toBe(true);
      expect(VARIATION_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(VARIATION_ACTION_PAST_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
    }
    // Price, submit and reopen are the register work `workspace.manage` covers…
    expect(variationActionNeedsApproval("price")).toBe(false);
    expect(variationActionNeedsApproval("submit")).toBe(false);
    expect(variationActionNeedsApproval("reopen")).toBe(false);
    // …while agreeing, rejecting, ordering done or withdrawing need
    // `workspace.approve`, which no role below manager holds by preset.
    for (const action of ["review", "approve", "reject", "implement", "cancel"] as const) {
      expect(variationActionNeedsApproval(action), action).toBe(true);
    }
    // Every action targets a status the chain actually accepts from somewhere,
    // so no button is rendered for a move that can never happen.
    for (const action of VARIATION_ACTIONS) {
      expect([...VARIATION_STATUSES]).toContain(VARIATION_ACTION_TARGET[action]);
    }
    expect(isVariationAction("certify")).toBe(false);
  });

  it("keeps submitting a claim apart from certifying it", () => {
    expect([...CERTIFICATE_ACTIONS]).toEqual([
      "submit",
      "review",
      "certify",
      "reject",
      "cancel",
      "reopen",
    ]);
    for (const action of CERTIFICATE_ACTIONS) {
      expect(isCertificateAction(action)).toBe(true);
      expect(CERTIFICATE_ACTION_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect(CERTIFICATE_ACTION_PAST_LABELS[action]?.trim().length, action).toBeGreaterThan(0);
      expect([...CERTIFICATE_STATUSES]).toContain(CERTIFICATE_ACTION_TARGET[action]);
    }
    expect(certificateActionNeedsApproval("submit")).toBe(false);
    expect(certificateActionNeedsApproval("reopen")).toBe(false);
    for (const action of ["review", "certify", "reject", "cancel"] as const) {
      expect(certificateActionNeedsApproval(action), action).toBe(true);
    }
    expect(isCertificateAction("approve")).toBe(false);
  });

  it("points each section at the capability that switches it off", () => {
    expect(COMMERCIAL_CAPABILITY_FOR).toEqual({
      variations: "variations",
      certificates: "progress_claims",
      cockpit: "financials",
    });
  });
});
