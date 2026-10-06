/**
 * Issue #799 §9 and §12 — the document-control catalogue's pure half: the two
 * status models, the issue-purpose list, and the two pieces of arithmetic the
 * register leans on (the revision code suggestion and §12's acknowledgement
 * rule).
 *
 * These cases pin the parts that a screen and the database must agree about.
 * The transition tables here are mirrored by migration 0197's triggers, and the
 * acknowledgement rule is mirrored by `aec_transmittal_guard()`, so a drift
 * between the two would show up as a button the database refuses — exactly the
 * failure these tests exist to prevent.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  canTransitionRevision,
  canTransitionTransmittal,
  disciplineLabel,
  isDocumentDiscipline,
  isDocumentType,
  isEditableRevision,
  isEditableTransmittal,
  isFullyAcknowledged,
  isIssuePurpose,
  isRevisionStatus,
  isTransmittalStatus,
  ISSUE_PURPOSES,
  ISSUE_PURPOSE_LABELS,
  nextRevisionNumber,
  pendingAcknowledgements,
  REVISION_STATUSES,
  REVISION_STATUS_LABELS,
  revisionCodeFor,
  suggestRevisionCode,
  TRANSMITTAL_STATUSES,
  TRANSMITTAL_STATUS_LABELS,
} from "./aec-docs";

describe("the document register's vocabularies", () => {
  it("carries §9's issue purposes in the issue's order, in Persian", () => {
    expect([...ISSUE_PURPOSES]).toEqual([
      "wip",
      "for_review",
      "for_approval",
      "for_tender",
      "for_construction",
      "as_built",
      "for_information",
    ]);
    expect(ISSUE_PURPOSE_LABELS.for_construction).toBe("جهت اجرا");
    expect(ISSUE_PURPOSE_LABELS.as_built).toBe("چون‌ساخت");
    expect(isIssuePurpose("for_tender")).toBe(true);
    expect(isIssuePurpose("issued")).toBe(false);
  });

  it("covers the document types a register actually files", () => {
    expect(DOCUMENT_TYPES).toContain("shop_drawing");
    expect(DOCUMENT_TYPES).toContain("as_built");
    expect(DOCUMENT_TYPE_LABELS.shop_drawing).toBe("نقشهٔ کارگاهی");
    expect(isDocumentType("calculation")).toBe(true);
    expect(isDocumentType("photo")).toBe(false);
  });

  it("borrows the disciplines from the business's own specialty catalogue", () => {
    // §9's discipline IS `AEC_SPECIALTIES` — the labels are imported, not
    // restated, so a second vocabulary cannot drift from the first.
    expect(isDocumentDiscipline("structural_engineering")).toBe(true);
    expect(isDocumentDiscipline("mep")).toBe(true);
    expect(isDocumentDiscipline("catering")).toBe(false);
    expect(disciplineLabel("architecture")).toBe("معماری");
    expect(disciplineLabel(null)).toBe("—");
    expect(disciplineLabel("nonsense")).toBe("—");
  });
});

describe("the revision status model", () => {
  it("carries §9's statuses with Persian labels", () => {
    expect([...REVISION_STATUSES]).toEqual(["draft", "issued", "superseded"]);
    expect(REVISION_STATUS_LABELS.issued).toBe("صادرشده");
    expect(isRevisionStatus("superseded")).toBe(true);
    expect(isRevisionStatus("approved")).toBe(false);
  });

  it("only ever moves forward", () => {
    expect(canTransitionRevision("draft", "issued")).toBe(true);
    expect(canTransitionRevision("issued", "superseded")).toBe(true);
    // An issued revision is a historical record: no way back, and no deleting
    // one's way out of it either.
    expect(canTransitionRevision("issued", "draft")).toBe(false);
    expect(canTransitionRevision("superseded", "draft")).toBe(false);
    expect(canTransitionRevision("superseded", "issued")).toBe(false);
  });

  it("lets only a draft be edited", () => {
    expect(isEditableRevision("draft")).toBe(true);
    expect(isEditableRevision("issued")).toBe(false);
    expect(isEditableRevision("superseded")).toBe(false);
  });
});

describe("the transmittal status model (§12)", () => {
  it("carries the three statuses with Persian labels", () => {
    expect([...TRANSMITTAL_STATUSES]).toEqual(["draft", "issued", "acknowledged"]);
    expect(TRANSMITTAL_STATUS_LABELS.acknowledged).toBe("رسید تأییدشده");
    expect(isTransmittalStatus("issued")).toBe(true);
    expect(isTransmittalStatus("sent")).toBe(false);
  });

  it("issues and acknowledges, and never goes back", () => {
    expect(canTransitionTransmittal("draft", "issued")).toBe(true);
    expect(canTransitionTransmittal("issued", "acknowledged")).toBe(true);
    expect(canTransitionTransmittal("issued", "draft")).toBe(false);
    expect(canTransitionTransmittal("acknowledged", "issued")).toBe(false);
    expect(isEditableTransmittal("draft")).toBe(true);
    expect(isEditableTransmittal("issued")).toBe(false);
    expect(isEditableTransmittal("acknowledged")).toBe(false);
  });

  it("counts only the receipts that were required", () => {
    const recipients = [
      { requiresAcknowledgement: true, acknowledgedAt: "2026-01-01T00:00:00Z" },
      { requiresAcknowledgement: true, acknowledgedAt: null },
      // A courtesy copy is not a pending signature.
      { requiresAcknowledgement: false, acknowledgedAt: null },
    ];
    expect(pendingAcknowledgements(recipients)).toBe(1);
    expect(isFullyAcknowledged(recipients)).toBe(false);
    expect(isFullyAcknowledged([recipients[0]])).toBe(true);
    // A transmittal with nobody on it is never "fully acknowledged".
    expect(isFullyAcknowledged([])).toBe(false);
  });
});

describe("revision numbering", () => {
  it("suggests letters the way a drawing office writes them", () => {
    expect(revisionCodeFor(1)).toBe("A");
    expect(revisionCodeFor(2)).toBe("B");
    expect(revisionCodeFor(26)).toBe("Z");
    expect(revisionCodeFor(27)).toBe("AA");
    expect(revisionCodeFor(28)).toBe("AB");
    expect(revisionCodeFor(52)).toBe("AZ");
    expect(revisionCodeFor(53)).toBe("BA");
  });

  it("treats a nonsense index as the first revision rather than throwing", () => {
    expect(revisionCodeFor(0)).toBe("A");
    expect(revisionCodeFor(-3)).toBe("A");
    expect(revisionCodeFor(1.5)).toBe("A");
  });

  it("numbers the next revision from the ones already there", () => {
    expect(nextRevisionNumber([])).toBe(1);
    expect(nextRevisionNumber([1])).toBe(2);
    // A register with a hole in it — 1 and 3 exist — still counts from the top,
    // because reusing 2 would make the order ambiguous.
    expect(nextRevisionNumber([1, 3])).toBe(4);
  });

  it("never suggests a code that is already taken", () => {
    expect(suggestRevisionCode([])).toBe("A");
    expect(suggestRevisionCode(["A"])).toBe("B");
    expect(suggestRevisionCode(["a", "B", "C"])).toBe("D");
    // A register that uses its own codes still gets a free suggestion.
    expect(suggestRevisionCode(["01", "02"])).toBe("A");
    expect(suggestRevisionCode(["A", "C"])).toBe("B");
  });
});
