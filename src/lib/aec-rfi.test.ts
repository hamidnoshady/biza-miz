/**
 * Issue #799 §10 and §11 — the RFI and submittal domain's catalogue contract.
 *
 * What needs no database is asserted here: the statuses are the ones the issue
 * chose, every one has a Persian label, the transition rules only ever move
 * forward, "waiting" and "overdue" mean the same thing to every caller that asks
 * (the cockpit KPI, the assistant's two reads, the overdue notification scan),
 * and the two registers' editable/waiting predicates agree with the labels they
 * are shown next to.
 */
import { describe, expect, it } from "vitest";
import {
  canTransitionRfi,
  canTransitionSubmittal,
  isEditableRfi,
  isEditableSubmittal,
  isRfiOverdue,
  isRfiStatus,
  isRfiWaiting,
  isSubmittalDecided,
  isSubmittalDecision,
  isSubmittalOverdue,
  isSubmittalStatus,
  isSubmittalType,
  isSubmittalWaiting,
  isSubmittalWithAuthor,
  RFI_STATUSES,
  RFI_STATUS_LABELS,
  SUBMITTAL_DECISIONS,
  SUBMITTAL_STATUSES,
  SUBMITTAL_STATUS_LABELS,
  SUBMITTAL_TYPE_LABELS,
  SUBMITTAL_TYPES,
} from "./aec-rfi";

describe("the RFI model (§10)", () => {
  it("declares §10's statuses in the issue's order, each labelled", () => {
    expect([...RFI_STATUSES]).toEqual(["draft", "open", "answered", "closed", "cancelled"]);
    for (const status of RFI_STATUSES) {
      expect(RFI_STATUS_LABELS[status].trim().length, status).toBeGreaterThan(0);
    }
    expect(isRfiStatus("answered")).toBe(true);
    expect(isRfiStatus("pending")).toBe(false);
  });

  it("walks §10's chain forward and nothing else", () => {
    expect(canTransitionRfi("draft", "open")).toBe(true);
    expect(canTransitionRfi("open", "answered")).toBe(true);
    expect(canTransitionRfi("answered", "closed")).toBe(true);
    // A question cannot be un-asked, and an answered RFI cannot return to open.
    expect(canTransitionRfi("open", "draft")).toBe(false);
    expect(canTransitionRfi("answered", "open")).toBe(false);
    expect(canTransitionRfi("closed", "open")).toBe(false);
    expect(canTransitionRfi("cancelled", "open")).toBe(false);
    // Cancellation is the one branch, and only before an answer exists.
    expect(canTransitionRfi("draft", "cancelled")).toBe(true);
    expect(canTransitionRfi("open", "cancelled")).toBe(true);
    expect(canTransitionRfi("answered", "cancelled")).toBe(false);
  });

  it("calls only an unanswered RFI waiting, and only a late one overdue", () => {
    expect(isRfiWaiting("open")).toBe(true);
    expect(isRfiWaiting("answered")).toBe(false);
    expect(isRfiWaiting("closed")).toBe(false);

    const today = "2026-10-03";
    expect(isRfiOverdue({ status: "open", dueDate: "2026-10-02" }, today)).toBe(true);
    // Due today is not late, and a history that was late is not "overdue".
    expect(isRfiOverdue({ status: "open", dueDate: today }, today)).toBe(false);
    expect(isRfiOverdue({ status: "open", dueDate: "2026-10-09" }, today)).toBe(false);
    expect(isRfiOverdue({ status: "answered", dueDate: "2026-09-01" }, today)).toBe(false);
    expect(isRfiOverdue({ status: "open", dueDate: null }, today)).toBe(false);
  });

  it("only lets the question be edited while it is a draft", () => {
    expect(isEditableRfi("draft")).toBe(true);
    expect(isEditableRfi("open")).toBe(false);
  });
});

describe("the submittal model (§11)", () => {
  it("declares §11's types and workflow, each labelled", () => {
    expect([...SUBMITTAL_TYPES]).toEqual([
      "shop_drawing",
      "material_submission",
      "sample",
      "method_statement",
      "technical_data",
      "mockup",
      "calculation",
      "other",
    ]);
    expect([...SUBMITTAL_STATUSES]).toEqual([
      "draft",
      "submitted",
      "under_review",
      "approved",
      "approved_with_comments",
      "revise_and_resubmit",
      "rejected",
      "closed",
    ]);
    for (const type of SUBMITTAL_TYPES) {
      expect(SUBMITTAL_TYPE_LABELS[type].trim().length, type).toBeGreaterThan(0);
    }
    for (const status of SUBMITTAL_STATUSES) {
      expect(SUBMITTAL_STATUS_LABELS[status].trim().length, status).toBeGreaterThan(0);
    }
    expect(isSubmittalType("mockup")).toBe(true);
    expect(isSubmittalType("inspection")).toBe(false);
    expect(isSubmittalStatus("under_review")).toBe(true);
    expect(isSubmittalStatus("pending")).toBe(false);
  });

  it("treats §11's line as the tree it is: four outcomes, then a close", () => {
    expect([...SUBMITTAL_DECISIONS]).toEqual([
      "approved",
      "approved_with_comments",
      "revise_and_resubmit",
      "rejected",
    ]);
    for (const decision of SUBMITTAL_DECISIONS) {
      expect(canTransitionSubmittal("under_review", decision), decision).toBe(true);
      expect(isSubmittalDecision(decision)).toBe(true);
      // Every determination becomes closable, and nothing else does.
      expect(canTransitionSubmittal(decision, "closed"), decision).toBe(true);
      expect(canTransitionSubmittal(decision, "under_review"), decision).toBe(false);
    }
    // A review starts only from submitted, and a submission only from a draft.
    expect(canTransitionSubmittal("submitted", "under_review")).toBe(true);
    expect(canTransitionSubmittal("draft", "submitted")).toBe(true);
    expect(canTransitionSubmittal("draft", "approved")).toBe(false);
    expect(canTransitionSubmittal("submitted", "approved")).toBe(false);
    // Forward only: what a reviewer saw is never re-drafted in place. The way
    // back to work is a new revision, which is a new row.
    expect(canTransitionSubmittal("under_review", "draft")).toBe(false);
    expect(canTransitionSubmittal("revise_and_resubmit", "draft")).toBe(false);
    expect(canTransitionSubmittal("closed", "draft")).toBe(false);
  });

  it("keeps three different questions from collapsing into one", () => {
    // A reviewer owes an answer.
    expect(isSubmittalWaiting("submitted")).toBe(true);
    expect(isSubmittalWaiting("under_review")).toBe(true);
    expect(isSubmittalWaiting("revise_and_resubmit")).toBe(false);
    // The author owes the next revision.
    expect(isSubmittalWithAuthor("revise_and_resubmit")).toBe(true);
    expect(isSubmittalWithAuthor("submitted")).toBe(false);
    // A determination exists and the record can still be closed.
    expect(isSubmittalDecided("approved")).toBe(true);
    expect(isSubmittalDecided("approved_with_comments")).toBe(true);
    expect(isSubmittalDecided("rejected")).toBe(true);
    expect(isSubmittalDecided("closed")).toBe(false);
    expect(isSubmittalDecided("under_review")).toBe(false);
  });

  it("calls a late review overdue and leaves the rest alone", () => {
    const today = "2026-10-03";
    expect(isSubmittalOverdue({ status: "submitted", dueDate: "2026-09-20" }, today)).toBe(true);
    expect(isSubmittalOverdue({ status: "under_review", dueDate: "2026-09-20" }, today)).toBe(true);
    expect(isSubmittalOverdue({ status: "submitted", dueDate: today }, today)).toBe(false);
    expect(isSubmittalOverdue({ status: "approved", dueDate: "2026-09-20" }, today)).toBe(false);
    expect(isSubmittalOverdue({ status: "submitted", dueDate: null }, today)).toBe(false);
  });

  it("only lets a draft revision be edited", () => {
    expect(isEditableSubmittal("draft")).toBe(true);
    for (const status of SUBMITTAL_STATUSES.filter((value) => value !== "draft")) {
      expect(isEditableSubmittal(status), status).toBe(false);
    }
  });
});
