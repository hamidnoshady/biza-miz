/**
 * Issue #799 §13 and §14 — the site-execution catalogue's contract.
 *
 * What needs no database is asserted here: §14's seven kinds exist and each has
 * a Persian label and its own number prefix, the lifecycle only ever moves
 * forward (with the one deliberate `resolved → in_progress` loop a failed
 * verification takes), the four moves are split across the two permissions the
 * service enforces, a day's numbers are counted from its lines rather than typed
 * on its header, and «late» means the same thing to the panel, the reminder scan
 * and the assistant.
 *
 * The service- and trigger-level halves of the same rules — the four-eyes
 * refusal, the CHECK constraints behind `SITE_LOG_LINE_SHAPES`, the RLS sweep —
 * are in `integration/aec-site.integration.test.ts`, because they need a
 * database to be worth asserting.
 */
import { describe, expect, it } from "vitest";
import {
  canTransitionSiteIssue,
  canTransitionSiteLog,
  isEditableSiteIssue,
  isEditableSiteLog,
  isOpenSiteIssue,
  isSiteCheckResult,
  isSiteChecklistKind,
  isSiteIssueAction,
  isSiteIssueCategory,
  isSiteIssueKind,
  isSiteIssueOverdue,
  isSiteIssueResult,
  isSiteIssueSeverity,
  isSiteIssueStatus,
  isSiteLogLineKind,
  isSiteLogStatus,
  issueNeedsResult,
  issueSupportsChecks,
  SITE_CHECK_RESULTS,
  SITE_CHECK_RESULT_LABELS,
  SITE_CHECKLIST_KINDS,
  SITE_CHECKLIST_KIND_LABELS,
  SITE_ISSUE_ACTIONS,
  SITE_ISSUE_CATEGORIES,
  SITE_ISSUE_CATEGORY_LABELS,
  SITE_ISSUE_KINDS,
  SITE_ISSUE_KIND_LABELS,
  SITE_ISSUE_NUMBER_PREFIXES,
  SITE_ISSUE_RESULT_LABELS,
  SITE_ISSUE_RESULTS,
  SITE_ISSUE_SEVERITIES,
  SITE_ISSUE_SEVERITY_LABELS,
  SITE_ISSUE_STATUSES,
  SITE_ISSUE_STATUS_LABELS,
  SITE_ISSUE_TRANSITIONS,
  SITE_LOG_LINE_KINDS,
  SITE_LOG_LINE_LABELS,
  SITE_LOG_LINE_SHAPES,
  SITE_LOG_STATUSES,
  SITE_LOG_STATUS_LABELS,
  siteIssueActionNeedsApproval,
  siteIssueKindCapability,
  siteIssueNumberPrefix,
  summariseSiteChecks,
  summariseSiteLogLines,
} from "./aec-site";

describe("the daily site log (§13)", () => {
  it("declares the two states a day has, each labelled", () => {
    expect([...SITE_LOG_STATUSES]).toEqual(["draft", "submitted"]);
    for (const status of SITE_LOG_STATUSES) {
      expect(SITE_LOG_STATUS_LABELS[status].trim().length, status).toBeGreaterThan(0);
    }
    expect(isSiteLogStatus("submitted")).toBe(true);
    expect(isSiteLogStatus("signed")).toBe(false);
  });

  it("walks a day forward, and back only for an explicit reopen", () => {
    expect(canTransitionSiteLog("draft", "submitted")).toBe(true);
    // Backwards is allowed — a site manager does reopen a day to add a truck
    // that arrived late — but it is a transition of its own, not a silent edit.
    expect(canTransitionSiteLog("submitted", "draft")).toBe(true);
    expect(canTransitionSiteLog("submitted", "submitted")).toBe(false);
    expect(canTransitionSiteLog("draft", "draft")).toBe(false);
    expect(canTransitionSiteLog("nonsense", "submitted")).toBe(false);
  });

  it("lets only a draft be edited, which is what the service and the trigger both check", () => {
    expect(isEditableSiteLog("draft")).toBe(true);
    expect(isEditableSiteLog("submitted")).toBe(false);
  });

  it("has §13's seven line kinds, each labelled", () => {
    expect([...SITE_LOG_LINE_KINDS]).toEqual([
      "attendance",
      "equipment",
      "material",
      "delay",
      "incident",
      "instruction",
      "visitor",
    ]);
    for (const kind of SITE_LOG_LINE_KINDS) {
      expect(SITE_LOG_LINE_LABELS[kind].trim().length, kind).toBeGreaterThan(0);
    }
    expect(isSiteLogLineKind("material")).toBe(true);
    expect(isSiteLogLineKind("subcontractor")).toBe(false);
  });

  it("gives every kind the inputs its line actually has", () => {
    // The shape is the contract the form and the database CHECK share: a
    // material line without a quantity, or an attendance line without a
    // headcount, is refused by both.
    for (const kind of SITE_LOG_LINE_KINDS) {
      const shape = SITE_LOG_LINE_SHAPES[kind];
      expect(shape ? Object.keys(shape).sort() : [], kind).toEqual(
        ["headcount", "hours", "party", "quantity", "unit"].sort(),
      );
    }
    expect(SITE_LOG_LINE_SHAPES.attendance.headcount).toBe(true);
    expect(SITE_LOG_LINE_SHAPES.attendance.quantity).toBe(false);
    expect(SITE_LOG_LINE_SHAPES.material.quantity).toBe(true);
    expect(SITE_LOG_LINE_SHAPES.material.headcount).toBe(false);
    expect(SITE_LOG_LINE_SHAPES.material.unit).toBe(true);
    expect(SITE_LOG_LINE_SHAPES.equipment.hours).toBe(true);
    // A visitor is a name, not a company: nobody records a visitor's headcount.
    expect(SITE_LOG_LINE_SHAPES.visitor.party).toBe(false);
    expect(SITE_LOG_LINE_SHAPES.visitor.headcount).toBe(false);
  });

  it("counts the day's numbers from its lines", () => {
    const summary = summariseSiteLogLines([
      { kind: "attendance", headcount: 12 },
      { kind: "attendance", headcount: 5 },
      { kind: "equipment" },
      { kind: "equipment" },
      { kind: "material" },
      { kind: "delay" },
      { kind: "incident" },
      { kind: "instruction" },
      { kind: "visitor" },
    ]);
    expect(summary).toEqual({
      workforce: 17,
      crews: 2,
      equipment: 2,
      deliveries: 1,
      delays: 1,
      incidents: 1,
      instructions: 1,
      visitors: 1,
    });
  });

  it("does not count a missing or nonsense headcount as people", () => {
    const summary = summariseSiteLogLines([
      { kind: "attendance" },
      { kind: "attendance", headcount: null },
      { kind: "attendance", headcount: -4 },
      { kind: "attendance", headcount: 3 },
    ]);
    expect(summary.workforce).toBe(3);
    expect(summary.crews).toBe(4);
    expect(summariseSiteLogLines([]).workforce).toBe(0);
  });
});

describe("the issue register (§14)", () => {
  it("declares §14's seven kinds, each labelled and numbered apart", () => {
    expect([...SITE_ISSUE_KINDS]).toEqual([
      "inspection_request",
      "inspection",
      "ncr",
      "corrective_action",
      "snag",
      "hse_observation",
      "handover",
    ]);
    const prefixes = new Set<string>();
    for (const kind of SITE_ISSUE_KINDS) {
      expect(SITE_ISSUE_KIND_LABELS[kind].trim().length, kind).toBeGreaterThan(0);
      const prefix = siteIssueNumberPrefix(kind);
      expect(prefix, kind).toBe(SITE_ISSUE_NUMBER_PREFIXES[kind]);
      // Two kinds sharing a prefix would make «SNG-004» ambiguous on a wall.
      expect(prefixes.has(prefix), prefix).toBe(false);
      prefixes.add(prefix);
    }
    expect(siteIssueNumberPrefix("snag")).toBe("SNG");
    expect(siteIssueNumberPrefix("ncr")).toBe("NCR");
    expect(isSiteIssueKind("punch")).toBe(false);
  });

  it("gates two kinds behind their own capability and the rest behind quality", () => {
    expect(siteIssueKindCapability("snag")).toBe("snagging");
    expect(siteIssueKindCapability("hse_observation")).toBe("hse");
    for (const kind of SITE_ISSUE_KINDS) {
      if (kind === "snag" || kind === "hse_observation") continue;
      expect(siteIssueKindCapability(kind), kind).toBe("qa_qc");
    }
  });

  it("only gives a result and a checklist to the kinds that have one", () => {
    expect(issueNeedsResult("inspection")).toBe(true);
    expect(issueNeedsResult("handover")).toBe(true);
    expect(issueNeedsResult("ncr")).toBe(false);
    expect(issueNeedsResult("snag")).toBe(false);
    expect(issueSupportsChecks("inspection")).toBe(true);
    expect(issueSupportsChecks("handover")).toBe(true);
    expect(issueSupportsChecks("corrective_action")).toBe(false);
  });

  it("declares the five states, each labelled", () => {
    expect([...SITE_ISSUE_STATUSES]).toEqual([
      "open",
      "in_progress",
      "resolved",
      "closed",
      "cancelled",
    ]);
    for (const status of SITE_ISSUE_STATUSES) {
      expect(SITE_ISSUE_STATUS_LABELS[status].trim().length, status).toBeGreaterThan(0);
    }
    expect(isSiteIssueStatus("resolved")).toBe(true);
    expect(isSiteIssueStatus("verified")).toBe(false);
  });

  it("walks §14's lifecycle forward, with the failed-verification loop", () => {
    expect(canTransitionSiteIssue("open", "in_progress")).toBe(true);
    expect(canTransitionSiteIssue("in_progress", "resolved")).toBe(true);
    expect(canTransitionSiteIssue("resolved", "closed")).toBe(true);
    // A rejected closeout sends the work back rather than closing it.
    expect(canTransitionSiteIssue("resolved", "in_progress")).toBe(true);
    // Nothing walks backwards otherwise, and nothing leaves a finished state.
    expect(canTransitionSiteIssue("in_progress", "open")).toBe(false);
    expect(canTransitionSiteIssue("closed", "open")).toBe(false);
    expect(canTransitionSiteIssue("cancelled", "in_progress")).toBe(false);
    expect(canTransitionSiteIssue("closed", "resolved")).toBe(false);
    expect(canTransitionSiteIssue("nonsense", "open")).toBe(false);
  });

  it("keeps §14's four moves, and only one of them is a decision", () => {
    expect([...SITE_ISSUE_ACTIONS]).toEqual(["start", "resolve", "close", "cancel"]);
    for (const action of SITE_ISSUE_ACTIONS) {
      expect(isSiteIssueAction(action), action).toBe(true);
    }
    expect(isSiteIssueAction("verify")).toBe(false);
    // Close is the closeout verification: it accepts somebody else's fix, so it
    // runs on `workspace.approve` while the other three run on `workspace.manage`.
    expect(siteIssueActionNeedsApproval("close")).toBe(true);
    expect(siteIssueActionNeedsApproval("start")).toBe(false);
    expect(siteIssueActionNeedsApproval("resolve")).toBe(false);
    expect(siteIssueActionNeedsApproval("cancel")).toBe(false);
  });

  it("treats what is not finished as editable and open", () => {
    for (const status of SITE_ISSUE_STATUSES) {
      const open = status !== "closed" && status !== "cancelled";
      expect(isOpenSiteIssue(status), status).toBe(open);
      expect(isEditableSiteIssue(status), status).toBe(open);
    }
  });

  it("calls a finding late only while it is unfinished and past its date", () => {
    const today = "1404-07-12";
    expect(isSiteIssueOverdue({ status: "open", dueDate: "1404-07-10" }, today)).toBe(true);
    // Awaiting verification is exactly the item a manager chases.
    expect(isSiteIssueOverdue({ status: "resolved", dueDate: "1404-07-10" }, today)).toBe(true);
    expect(isSiteIssueOverdue({ status: "closed", dueDate: "1404-07-10" }, today)).toBe(false);
    expect(isSiteIssueOverdue({ status: "cancelled", dueDate: "1404-07-10" }, today)).toBe(false);
    expect(isSiteIssueOverdue({ status: "open", dueDate: today }, today)).toBe(false);
    expect(isSiteIssueOverdue({ status: "open", dueDate: "1404-07-20" }, today)).toBe(false);
    // No due date is not a deadline, so it is not a missed one.
    expect(isSiteIssueOverdue({ status: "open", dueDate: null }, today)).toBe(false);
    expect(isSiteIssueOverdue({ status: "open" }, today)).toBe(false);
  });

  it("has §14's four severities, each labelled", () => {
    expect([...SITE_ISSUE_SEVERITIES]).toEqual(["low", "medium", "high", "critical"]);
    for (const severity of SITE_ISSUE_SEVERITIES) {
      expect(SITE_ISSUE_SEVERITY_LABELS[severity].trim().length, severity).toBeGreaterThan(0);
    }
    expect(isSiteIssueSeverity("critical")).toBe(true);
    expect(isSiteIssueSeverity("urgent")).toBe(false);
  });

  it("has a category for each of §14's trades, each labelled", () => {
    for (const category of SITE_ISSUE_CATEGORIES) {
      expect(SITE_ISSUE_CATEGORY_LABELS[category].trim().length, category).toBeGreaterThan(0);
    }
    // ‎«سازه» and «تأسیسات» are the two categories a snag list cannot do without.
    expect(isSiteIssueCategory("structural")).toBe(true);
    expect(isSiteIssueCategory("mep")).toBe(true);
    expect(isSiteIssueCategory("catering")).toBe(false);
  });

  it("has the three inspection results §14 asks for, each labelled", () => {
    expect([...SITE_ISSUE_RESULTS]).toEqual(["pass", "pass_with_comments", "fail"]);
    for (const result of SITE_ISSUE_RESULTS) {
      expect(SITE_ISSUE_RESULT_LABELS[result].trim().length, result).toBeGreaterThan(0);
    }
    expect(isSiteIssueResult("pass_with_comments")).toBe(true);
    expect(isSiteIssueResult("pending")).toBe(false);
  });
});

describe("checklists (§14)", () => {
  it("has the two kinds §14 names — inspection and handover", () => {
    expect([...SITE_CHECKLIST_KINDS]).toEqual(["inspection", "handover"]);
    for (const kind of SITE_CHECKLIST_KINDS) {
      expect(SITE_CHECKLIST_KIND_LABELS[kind].trim().length, kind).toBeGreaterThan(0);
    }
    expect(isSiteChecklistKind("handover")).toBe(true);
    expect(isSiteChecklistKind("snag")).toBe(false);
  });

  it("has the four states a checklist line can be in, each labelled", () => {
    expect([...SITE_CHECK_RESULTS]).toEqual(["pending", "pass", "fail", "na"]);
    for (const result of SITE_CHECK_RESULTS) {
      expect(SITE_CHECK_RESULT_LABELS[result].trim().length, result).toBeGreaterThan(0);
    }
    expect(isSiteCheckResult("na")).toBe(true);
    expect(isSiteCheckResult("skip")).toBe(false);
  });

  it("summarises a checklist, and only a fully answered one is complete", () => {
    const summary = summariseSiteChecks([
      { result: "pass" },
      { result: "pass" },
      { result: "fail" },
      { result: "na" },
      { result: "pending" },
    ]);
    expect(summary).toEqual({
      total: 5,
      passed: 2,
      failed: 1,
      pending: 1,
      notApplicable: 1,
      complete: false,
    });
    expect(summariseSiteChecks([{ result: "pass" }, { result: "na" }]).complete).toBe(true);
    // An inspection with no checklist lines at all is not a completed one; there
    // is nothing to have signed.
    expect(summariseSiteChecks([]).complete).toBe(false);
    expect(summariseSiteChecks([]).total).toBe(0);
  });

  it("counts a nonsense result as not-yet-answered rather than as a pass", () => {
    const summary = summariseSiteChecks([{ result: "roughly-ok" }, { result: "pass" }]);
    expect(summary.passed).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.complete).toBe(false);
  });
});

describe("the register the reminder scan walks (§29)", () => {
  it("has exactly one status per stage of §14's life, so a scan cannot miss one", () => {
    // `pending` / `overdue` are views over the same five statuses, not a second
    // vocabulary — the reason the scan reads `isOpenSiteIssue`.
    const transitioned = new Set<string>();
    for (const status of SITE_ISSUE_STATUSES) {
      for (const next of SITE_ISSUE_TRANSITIONS[status]) transitioned.add(next);
    }
    expect([...transitioned].sort()).toEqual(
      [...SITE_ISSUE_STATUSES].filter((status) => status !== "open").sort(),
    );
    for (const status of SITE_ISSUE_STATUSES) {
      expect(Array.isArray(SITE_ISSUE_TRANSITIONS[status]), status).toBe(true);
    }
  });
});
