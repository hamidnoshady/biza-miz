/**
 * Issue #1128 §D — the commercial registers' rules, as tests.
 *
 * `agency-commercial.ts` is pure, so every claim §D makes about an agency's
 * money is checkable here without a database: which transitions exist, which of
 * them are decisions rather than edits, where a remainder goes when a contract
 * value is split, what a percentage of an unpriced contract answers, and which
 * half of the P&L a figure came from.
 *
 * The tests are written to fail on the mistakes that actually happen in a
 * billing register — a schedule that does not sum to its own engagement, a
 * margin computed from a plan instead of from the ledger, a status a screen can
 * reach but the service cannot, and a module that quietly grew a permission
 * check.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  addMonthsIso,
  AGENCY_BILLING_BASES,
  AGENCY_BILLING_BASE_DESCRIPTIONS,
  AGENCY_BILLING_BASE_LABELS,
  AGENCY_CHANGE_REQUEST_ACTIONS,
  AGENCY_CHANGE_REQUEST_STATUS_LABELS,
  AGENCY_CHANGE_REQUEST_STATUSES,
  AGENCY_MILESTONE_ACTIONS,
  AGENCY_MILESTONE_KIND_LABELS,
  AGENCY_MILESTONE_KINDS,
  AGENCY_MILESTONE_PERCENT_MAX,
  AGENCY_MILESTONE_REVENUE_ACCOUNTS,
  AGENCY_MILESTONE_STATUS_LABELS,
  AGENCY_MILESTONE_STATUSES,
  AGENCY_SCHEDULE_MAX_DELIVERABLES,
  AGENCY_SCHEDULE_MAX_PERIODS,
  agencyCommercialDeterminationActions,
  canTransitionChangeRequest,
  canTransitionMilestone,
  changeRequestMovesContractValue,
  CHANGE_REQUEST_NUMBER_PREFIX,
  changeRequestTransitionsFrom,
  commercialMargin,
  draftScheduleForBase,
  formatPercent,
  isAgencyBillingBase,
  isAgencyChangeRequestStatus,
  isAgencyMilestoneKind,
  isAgencyMilestoneStatus,
  isBillableMilestone,
  isEditableChangeRequest,
  isEditableMilestone,
  isSafeRial,
  isSignedRial,
  isValidMilestoneAmount,
  MILESTONE_NUMBER_PREFIX,
  milestoneAmountRial,
  milestoneTransitionsFrom,
  retainerPeriods,
  revisedContractValueRial,
  scheduleTotals,
  splitAmountRial,
  splitPercent,
  splitPercentOf,
  toPersianOrdinal,
  unscheduledValueRial,
  type AgencyMilestoneDraft,
  type AgencyMilestoneStatus,
} from "./agency-commercial";
import { SERVICE_REVENUE_ACCOUNTS } from "./service-invoice";

/** Words that belong to a shop or a café, not to an agency (§ non-goals). */
const RETAIL_WORDS = ["منو", "سفارش", "صندوق", "میز", "آشپزخانه", "انبار", "کالا"];

describe("§D's engagement shapes", () => {
  it("names the four ways a client agrees to pay, in Persian", () => {
    expect([...AGENCY_BILLING_BASES]).toEqual(["fixed_price", "milestone", "retainer", "hourly"]);
    for (const base of AGENCY_BILLING_BASES) {
      expect(AGENCY_BILLING_BASE_LABELS[base], base).toBeTruthy();
      expect(AGENCY_BILLING_BASE_DESCRIPTIONS[base], base).toBeTruthy();
      expect(isAgencyBillingBase(base), base).toBe(true);
    }
    expect(isAgencyBillingBase("subscription")).toBe(false);
    expect(isAgencyBillingBase("")).toBe(false);
    expect(isAgencyBillingBase(undefined)).toBe(false);
    expect(isAgencyBillingBase(42)).toBe(false);
  });

  it("says nothing in the vocabulary of a shop or a café", () => {
    const copy = [
      ...Object.values(AGENCY_BILLING_BASE_LABELS),
      ...Object.values(AGENCY_BILLING_BASE_DESCRIPTIONS),
      ...Object.values(AGENCY_MILESTONE_KIND_LABELS),
      ...Object.values(AGENCY_MILESTONE_STATUS_LABELS),
      ...Object.values(AGENCY_CHANGE_REQUEST_STATUS_LABELS),
      ...AGENCY_MILESTONE_ACTIONS.map((entry) => entry.label),
      ...AGENCY_CHANGE_REQUEST_ACTIONS.map((entry) => entry.label),
    ].join(" ");
    for (const word of RETAIL_WORDS) {
      expect(copy, word).not.toContain(word);
    }
    // The trade's own noun for a sale document, and not another trade's.
    expect(AGENCY_MILESTONE_STATUS_LABELS.invoiced).toContain("صورتحساب");
    expect(copy).not.toContain("فاکتور");
  });
});

describe("the billing schedule's chain", () => {
  it("labels every kind and every status, and guards both", () => {
    expect([...AGENCY_MILESTONE_KINDS]).toEqual([
      "deposit",
      "deliverable",
      "retainer_period",
      "final",
    ]);
    expect([...AGENCY_MILESTONE_STATUSES]).toEqual([
      "draft",
      "submitted",
      "approved",
      "invoiced",
      "rejected",
      "cancelled",
    ]);
    for (const kind of AGENCY_MILESTONE_KINDS) {
      expect(AGENCY_MILESTONE_KIND_LABELS[kind], kind).toBeTruthy();
      expect(isAgencyMilestoneKind(kind), kind).toBe(true);
    }
    for (const status of AGENCY_MILESTONE_STATUSES) {
      expect(AGENCY_MILESTONE_STATUS_LABELS[status], status).toBeTruthy();
      expect(isAgencyMilestoneStatus(status), status).toBe(true);
    }
    expect(isAgencyMilestoneKind("payment")).toBe(false);
    expect(isAgencyMilestoneStatus("paid")).toBe(false);
  });

  it("reaches only the documented transitions, and never itself", () => {
    expect(canTransitionMilestone("draft", "submitted")).toBe(true);
    expect(canTransitionMilestone("draft", "invoiced")).toBe(false);
    expect(canTransitionMilestone("submitted", "approved")).toBe(true);
    expect(canTransitionMilestone("submitted", "invoiced")).toBe(false);
    expect(canTransitionMilestone("approved", "invoiced")).toBe(true);
    expect(canTransitionMilestone("rejected", "draft")).toBe(true);
    for (const from of AGENCY_MILESTONE_STATUSES) {
      expect(canTransitionMilestone(from, from), from).toBe(false);
      for (const to of milestoneTransitionsFrom(from)) {
        expect(AGENCY_MILESTONE_STATUSES, `${from}→${to}`).toContain(to);
      }
    }
  });

  it("can only be invoiced from approved, and ends at invoiced or cancelled", () => {
    // Issuing an invoice is the one act with money behind it, so the chain
    // narrows to a single door: nothing drafts, submits or refuses its way
    // straight onto a client's invoice.
    for (const status of AGENCY_MILESTONE_STATUSES) {
      expect(canTransitionMilestone(status, "invoiced"), status).toBe(status === "approved");
    }
    expect(milestoneTransitionsFrom("invoiced")).toEqual([]);
    expect(milestoneTransitionsFrom("cancelled")).toEqual([]);
  });

  it("is editable only while nobody has decided, and billable only when approved", () => {
    for (const status of AGENCY_MILESTONE_STATUSES) {
      expect(isEditableMilestone(status), status).toBe(
        status === "draft" || status === "rejected",
      );
      expect(isBillableMilestone(status), status).toBe(status === "approved");
    }
    // A submitted milestone is frozen: it is what an approver is reading.
    expect(isEditableMilestone("submitted")).toBe(false);
  });

  it("numbers per project, with its own prefix", () => {
    expect(MILESTONE_NUMBER_PREFIX).toBe("MS");
    expect(CHANGE_REQUEST_NUMBER_PREFIX).toBe("CR");
    expect(MILESTONE_NUMBER_PREFIX).not.toBe(CHANGE_REQUEST_NUMBER_PREFIX);
  });
});

describe("a milestone's amount", () => {
  it("takes exactly one of a percentage or a fixed Rial amount", () => {
    expect(isValidMilestoneAmount({ percent: 30, amountRial: null })).toBe(true);
    expect(isValidMilestoneAmount({ percent: null, amountRial: 5_000_000 })).toBe(true);
    // Both is two answers; neither is nothing to bill.
    expect(isValidMilestoneAmount({ percent: 30, amountRial: 5_000_000 })).toBe(false);
    expect(isValidMilestoneAmount({ percent: null, amountRial: null })).toBe(false);
    expect(isValidMilestoneAmount({ percent: 0, amountRial: null })).toBe(false);
    expect(isValidMilestoneAmount({ percent: -5, amountRial: null })).toBe(false);
    expect(isValidMilestoneAmount({ percent: AGENCY_MILESTONE_PERCENT_MAX + 1, amountRial: null })).toBe(
      false,
    );
    expect(isValidMilestoneAmount({ percent: AGENCY_MILESTONE_PERCENT_MAX, amountRial: null })).toBe(
      true,
    );
    expect(isValidMilestoneAmount({ percent: null, amountRial: 0 })).toBe(false);
    expect(isValidMilestoneAmount({ percent: null, amountRial: -1 })).toBe(false);
    expect(isValidMilestoneAmount({ percent: null, amountRial: 1.5 })).toBe(false);
    expect(isValidMilestoneAmount({ percent: Number.NaN, amountRial: null })).toBe(false);
  });

  it("bills a percentage of the revised value, rounded to whole Rial once", () => {
    expect(milestoneAmountRial({ percent: 30, amountRial: null }, 100_000_000)).toBe(30_000_000);
    expect(milestoneAmountRial({ percent: 33.33, amountRial: null }, 100)).toBe(33);
    expect(milestoneAmountRial({ percent: 100, amountRial: null }, 1_000)).toBe(1_000);
    expect(milestoneAmountRial({ percent: null, amountRial: 7_500_000 }, null)).toBe(7_500_000);
  });

  it("answers null — never zero — for a percentage of an unpriced contract", () => {
    // "No value on the contract" is not "this milestone is free": answering 0
    // would let an invoice be issued for nothing instead of refusing with a
    // sentence, and the report would show a scheduled amount that cannot exist.
    expect(milestoneAmountRial({ percent: 30, amountRial: null }, null)).toBeNull();
    expect(milestoneAmountRial({ percent: 30, amountRial: null }, -100)).toBeNull();
    expect(milestoneAmountRial({ percent: 30, amountRial: null }, 1.5)).toBeNull();
    // And an invalid amount is null whatever the contract says.
    expect(milestoneAmountRial({ percent: null, amountRial: null }, 100_000_000)).toBeNull();
  });

  it("knows whole Rial from anything else", () => {
    expect(isSafeRial(0)).toBe(true);
    expect(isSafeRial(1_000)).toBe(true);
    expect(isSafeRial(-1)).toBe(false);
    expect(isSafeRial(1.5)).toBe(false);
    expect(isSafeRial(Number.MAX_SAFE_INTEGER + 10)).toBe(false);
    expect(isSafeRial("1000")).toBe(false);
    // A change request may reduce an engagement, but never by nothing at all.
    expect(isSignedRial(-500)).toBe(true);
    expect(isSignedRial(500)).toBe(true);
    expect(isSignedRial(0)).toBe(false);
    expect(isSignedRial(1.5)).toBe(false);
  });
});

describe("splitting money and percents", () => {
  it("puts the remainder on the last share, so the parts sum exactly", () => {
    expect(splitAmountRial(100, 3)).toEqual([33, 33, 34]);
    expect(splitAmountRial(100_000_000, 3).reduce((a, b) => a + b, 0)).toBe(100_000_000);
    expect(splitAmountRial(99, 3)).toEqual([33, 33, 33]);
    expect(splitAmountRial(10, 1)).toEqual([10]);
    expect(splitAmountRial(0, 3)).toEqual([0, 0, 0]);
    expect(splitAmountRial(-100, 3)).toEqual([]);
    expect(splitAmountRial(100, 0)).toEqual([]);
    expect(splitAmountRial(100.5, 2)).toEqual([]);
  });

  it("splits 100% exactly, however many parts it is split into", () => {
    expect(splitPercent(3)).toEqual([33.33, 33.33, 33.34]);
    expect(splitPercent(1)).toEqual([100]);
    for (const parts of [2, 3, 6, 7, 12, 24]) {
      const shares = splitPercent(parts);
      expect(shares, `${parts} parts`).toHaveLength(parts);
      expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100), `${parts} parts`).toBe(10_000);
    }
    expect(splitPercent(0)).toEqual([]);
    expect(splitPercent(-3)).toEqual([]);
  });

  it("splits an arbitrary percent total the same way", () => {
    expect(splitPercentOf(70, 3)).toEqual([23.33, 23.33, 23.34]);
    expect(Math.round(splitPercentOf(70, 3).reduce((a, b) => a + b, 0) * 100)).toBe(7_000);
    expect(splitPercentOf(100, 4)).toEqual([25, 25, 25, 25]);
    expect(splitPercentOf(0, 3)).toEqual([]);
    expect(splitPercentOf(-10, 3)).toEqual([]);
  });

  it("reports what a schedule leaves unallocated", () => {
    const drafts: AgencyMilestoneDraft[] = [
      { kind: "deposit", title: "پ", percent: 30, amountRial: null, dueOffsetMonths: 0 },
      { kind: "deliverable", title: "د", percent: 30, amountRial: null, dueOffsetMonths: 1 },
      { kind: "retainer_period", title: "ر", percent: null, amountRial: 5_000_000, dueOffsetMonths: 2 },
    ];
    expect(scheduleTotals(drafts)).toEqual({
      unallocatedPercent: 40,
      fixedTotalRial: 5_000_000,
      count: 3,
    });
    expect(scheduleTotals([])).toEqual({ unallocatedPercent: 100, fixedTotalRial: 0, count: 0 });
  });
});

describe("laying a schedule out from the engagement's base", () => {
  it("gives a fixed-price engagement a deposit and a final settlement", () => {
    const drafts = draftScheduleForBase("fixed_price", {
      contractValueRial: 100_000_000,
      depositPercent: 30,
    });
    expect(drafts.map((draft) => [draft.kind, draft.percent])).toEqual([
      ["deposit", 30],
      ["final", 70],
    ]);
    expect(scheduleTotals(drafts).unallocatedPercent).toBe(0);
    expect(drafts[0].title).toContain("۳۰٪");
    expect(drafts[0].dueOffsetMonths).toBe(0);
    expect(drafts[1].dueOffsetMonths).toBe(1);
  });

  it("gives a fixed-price engagement with no deposit one line for the whole value", () => {
    const drafts = draftScheduleForBase("fixed_price", { contractValueRial: 40_000_000 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: "final", percent: 100, amountRial: null });
    // And an unpriced engagement still lays out — with percents, not amounts,
    // because a percentage needs no value to be *written*, only to be billed.
    expect(draftScheduleForBase("fixed_price", { contractValueRial: null })).toHaveLength(1);
  });

  it("splits a milestone engagement across its delivery stages, remainder included", () => {
    const drafts = draftScheduleForBase("milestone", {
      contractValueRial: 90_000_000,
      depositPercent: 30,
      deliverables: 3,
    });
    expect(drafts.map((draft) => draft.kind)).toEqual([
      "deposit",
      "deliverable",
      "deliverable",
      "final",
    ]);
    expect(drafts.map((draft) => draft.percent)).toEqual([30, 23.33, 23.33, 23.34]);
    // The invariant the service later refuses to store a schedule without: the
    // plan adds up to exactly the engagement, so no Rial is invented or lost
    // between the contract and its own billing schedule.
    expect(scheduleTotals(drafts).unallocatedPercent).toBe(0);
    expect(drafts.every((draft) => draft.amountRial === null)).toBe(true);
  });

  it("clamps a milestone schedule to the counts it accepts", () => {
    expect(
      draftScheduleForBase("milestone", { contractValueRial: 1000, deliverables: 99 }),
    ).toHaveLength(AGENCY_SCHEDULE_MAX_DELIVERABLES);
    // The defaults are the ones a small agency actually writes.
    expect(draftScheduleForBase("milestone", { contractValueRial: 1000 })).toHaveLength(3);
    expect(draftScheduleForBase("milestone", { contractValueRial: 1000, deliverables: 0 })).toHaveLength(
      3,
    );
  });

  it("lays a retainer out as periods that sum to the engagement", () => {
    const drafts = draftScheduleForBase("retainer", {
      contractValueRial: 100_000_000,
      periods: 3,
    });
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.amountRial)).toEqual([33_333_333, 33_333_333, 33_333_334]);
    expect(drafts.reduce((sum, draft) => sum + (draft.amountRial ?? 0), 0)).toBe(100_000_000);
    expect(drafts.every((draft) => draft.kind === "retainer_period")).toBe(true);
    expect(drafts.every((draft) => draft.percent === null)).toBe(true);
    expect(drafts.map((draft) => draft.dueOffsetMonths)).toEqual([0, 1, 2]);
    expect(drafts[2].title).toContain("۳");
  });

  it("prefers an explicit period amount to a division of the total", () => {
    // A retainer is usually a number the client agreed to per month. Twelve of
    // those do not have to sum to the contract value, and forcing them to would
    // rewrite the agreement.
    const drafts = draftScheduleForBase("retainer", {
      contractValueRial: 100_000_000,
      periodAmountRial: 5_000_000,
      periods: 6,
    });
    expect(drafts).toHaveLength(6);
    expect(drafts.every((draft) => draft.amountRial === 5_000_000)).toBe(true);
  });

  it("defaults a retainer to twelve periods and clamps an absurd count", () => {
    expect(draftScheduleForBase("retainer", { contractValueRial: 12_000_000 })).toHaveLength(12);
    expect(
      draftScheduleForBase("retainer", { contractValueRial: 12_000_000, periods: 999 }),
    ).toHaveLength(AGENCY_SCHEDULE_MAX_PERIODS);
    // An unpriced retainer with no period amount has nothing to put on a line,
    // and says so with null rather than inventing a figure.
    const drafts = draftScheduleForBase("retainer", { contractValueRial: null, periods: 4 });
    expect(drafts).toHaveLength(4);
    expect(drafts.every((draft) => draft.amountRial === null)).toBe(true);
  });

  it("lays nothing out for hourly work, and says why in the module", () => {
    // An hourly engagement bills a period once the time and the pass-through
    // cost in it are known. Twelve rows with no amount would be twelve booked
    // figures with nothing behind them — the one thing §D's P&L must not show.
    expect(draftScheduleForBase("hourly", { contractValueRial: 100_000_000, periods: 12 })).toEqual(
      [],
    );
  });
});

describe("retainer dates", () => {
  it("adds calendar months and clamps to the month's last day", () => {
    expect(addMonthsIso("2026-03-21", 1)).toBe("2026-04-21");
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonthsIso("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsIso("2026-03-21", 0)).toBe("2026-03-21");
    expect(addMonthsIso("2026-03-21", -1)).toBe("2026-02-21");
    // A date it cannot parse is returned as it came, not turned into "Invalid".
    expect(addMonthsIso("not-a-date", 1)).toBe("not-a-date");
  });

  it("adds days in UTC, so a Shamsi day cannot shift", () => {
    expect(addDaysIso("2026-03-21", 1)).toBe("2026-03-22");
    expect(addDaysIso("2026-04-21", -1)).toBe("2026-04-20");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("covers a retainer year with no gap and no overlap", () => {
    const periods = retainerPeriods("2026-03-21", 12);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ index: 1, startIso: "2026-03-21", endIso: "2026-04-20" });
    expect(periods[11]).toEqual({ index: 12, startIso: "2027-02-21", endIso: "2027-03-20" });
    for (let index = 1; index < periods.length; index += 1) {
      // The next period starts the day after the previous one ends: a client
      // disputes a retainer invoice about the dates before the amount.
      expect(periods[index].startIso, `period ${index + 1}`).toBe(
        addDaysIso(periods[index - 1].endIso, 1),
      );
      expect(periods[index].index).toBe(index + 1);
    }
    expect(retainerPeriods("2026-03-21", 0)).toEqual([]);
    expect(retainerPeriods("2026-03-21", 999)).toHaveLength(AGENCY_SCHEDULE_MAX_PERIODS);
  });
});

describe("§D's change requests", () => {
  it("labels every status and reaches only the documented transitions", () => {
    expect([...AGENCY_CHANGE_REQUEST_STATUSES]).toEqual([
      "draft",
      "priced",
      "submitted",
      "approved",
      "rejected",
      "implemented",
      "withdrawn",
    ]);
    for (const status of AGENCY_CHANGE_REQUEST_STATUSES) {
      expect(AGENCY_CHANGE_REQUEST_STATUS_LABELS[status], status).toBeTruthy();
      expect(isAgencyChangeRequestStatus(status), status).toBe(true);
      expect(canTransitionChangeRequest(status, status), status).toBe(false);
      for (const to of changeRequestTransitionsFrom(status)) {
        expect(AGENCY_CHANGE_REQUEST_STATUSES, `${status}→${to}`).toContain(to);
      }
    }
    expect(isAgencyChangeRequestStatus("variation")).toBe(false);
    expect(canTransitionChangeRequest("draft", "submitted")).toBe(false);
    expect(canTransitionChangeRequest("draft", "priced")).toBe(true);
    expect(canTransitionChangeRequest("priced", "submitted")).toBe(true);
    expect(canTransitionChangeRequest("submitted", "approved")).toBe(true);
    expect(canTransitionChangeRequest("approved", "implemented")).toBe(true);
    expect(canTransitionChangeRequest("rejected", "priced")).toBe(true);
    expect(changeRequestTransitionsFrom("implemented")).toEqual([]);
    expect(changeRequestTransitionsFrom("withdrawn")).toEqual([]);
  });

  it("is editable until the client is reading it, and never after a decision", () => {
    for (const status of AGENCY_CHANGE_REQUEST_STATUSES) {
      expect(isEditableChangeRequest(status), status).toBe(
        status === "draft" || status === "priced" || status === "rejected",
      );
    }
    expect(isEditableChangeRequest("submitted")).toBe(false);
    expect(isEditableChangeRequest("approved")).toBe(false);
  });

  it("moves the engagement's value only when approved or implemented", () => {
    // A priced request is an intention and a submitted one is a question.
    // Counting either would report revenue the client has not agreed to —
    // exactly the booked/posted confusion §D forbids.
    for (const status of AGENCY_CHANGE_REQUEST_STATUSES) {
      expect(changeRequestMovesContractValue(status), status).toBe(
        status === "approved" || status === "implemented",
      );
    }
  });

  it("adds approved requests to the signed value, and never rewrites it", () => {
    expect(revisedContractValueRial(100_000_000, [20_000_000])).toBe(120_000_000);
    expect(revisedContractValueRial(100_000_000, [20_000_000, -30_000_000])).toBe(90_000_000);
    expect(revisedContractValueRial(100_000_000, [])).toBe(100_000_000);
    // A descope is negative rather than a second column, so a register cannot
    // hold two figures that must agree with each other.
    expect(revisedContractValueRial(100_000_000, [-100_000_000])).toBe(0);
    // An unpriced contract has no revised value either, and a descope larger
    // than the engagement is refused rather than reported as negative money.
    expect(revisedContractValueRial(null, [20_000_000])).toBeNull();
    expect(revisedContractValueRial(100_000_000, [-200_000_000])).toBeNull();
  });
});

describe("which acts are decisions", () => {
  it("targets a real status and labels itself in Persian", () => {
    for (const entry of AGENCY_MILESTONE_ACTIONS) {
      expect(AGENCY_MILESTONE_STATUSES, entry.action).toContain(
        entry.target as AgencyMilestoneStatus,
      );
      expect(entry.label, entry.action).toBeTruthy();
    }
    for (const entry of AGENCY_CHANGE_REQUEST_ACTIONS) {
      expect(AGENCY_CHANGE_REQUEST_STATUSES, entry.action).toContain(entry.target);
      expect(entry.label, entry.action).toBeTruthy();
    }
  });

  it("gates the determinations apart from ordinary edits", () => {
    // §24's rule, inherited: writing a register is `workspace.manage`, deciding
    // is `workspace.approve`. Stated here once so six route handlers cannot
    // each invent their own split.
    expect(agencyCommercialDeterminationActions(AGENCY_MILESTONE_ACTIONS)).toEqual([
      "submit",
      "approve",
      "reject",
      "invoice",
      "cancel",
    ]);
    expect(agencyCommercialDeterminationActions(AGENCY_CHANGE_REQUEST_ACTIONS)).toEqual([
      "submit",
      "approve",
      "reject",
      "withdraw",
    ]);
    // Issuing an invoice is a decision, and pricing a change is not.
    expect(AGENCY_MILESTONE_ACTIONS.find((entry) => entry.action === "invoice")?.determination).toBe(
      true,
    );
    expect(
      AGENCY_CHANGE_REQUEST_ACTIONS.find((entry) => entry.action === "price")?.determination,
    ).toBe(false);
  });
});

describe("§D's P&L keeps booked apart from posted", () => {
  it("computes a margin only from posted figures", () => {
    expect(commercialMargin(100_000_000, 40_000_000)).toEqual({
      grossMarginRial: 60_000_000,
      grossMarginPercent: 60,
    });
    expect(commercialMargin(3, 1).grossMarginPercent).toBe(66.67);
    expect(commercialMargin(100_000_000, 120_000_000)).toEqual({
      grossMarginRial: -20_000_000,
      grossMarginPercent: -20,
    });
  });

  it("answers null rather than zero when the ledger does not know yet", () => {
    expect(commercialMargin(null, 40_000_000)).toEqual({
      grossMarginRial: null,
      grossMarginPercent: null,
    });
    expect(commercialMargin(100_000_000, null).grossMarginRial).toBeNull();
    // Nothing billed has no margin *rate*; 0% would claim the campaign broke
    // even rather than that it has not invoiced.
    expect(commercialMargin(0, 0)).toEqual({ grossMarginRial: 0, grossMarginPercent: null });
    expect(unscheduledValueRial(null, 40_000_000)).toBeNull();
    expect(unscheduledValueRial(100_000_000, 40_000_000)).toBe(60_000_000);
  });
});

describe("the revenue accounts a milestone may credit", () => {
  it("are the trade's own four, read from service-invoice.ts rather than copied", () => {
    // Identity, not equality: a second list of the same four codes would be a
    // second place to forget one, and the invoice would then refuse the account
    // its own schedule offered.
    expect(AGENCY_MILESTONE_REVENUE_ACCOUNTS).toBe(SERVICE_REVENUE_ACCOUNTS.advertising_agency);
    expect(AGENCY_MILESTONE_REVENUE_ACCOUNTS.map((account) => account.code)).toEqual([
      "4640",
      "4650",
      "4660",
      "4670",
    ]);
    for (const account of AGENCY_MILESTONE_REVENUE_ACCOUNTS) {
      expect(account.label, account.code).toBeTruthy();
    }
  });
});

describe("the copy this module makes", () => {
  it("formats a percent the way a person reads it", () => {
    expect(formatPercent(30)).toBe("۳۰٪");
    expect(formatPercent(33.33)).toBe("۳۳٫۳۳٪");
    expect(formatPercent(100)).toBe("۱۰۰٪");
    expect(toPersianOrdinal(3)).toBe("۳");
    expect(toPersianOrdinal(12)).toBe("۱۲");
  });
});

describe("the module cannot decide an authorization", () => {
  it("imports nothing but two other pure modules", () => {
    // The mechanical half of "a preset is never an authorization axis", applied
    // to the commercial registers: this file has no `./permissions`, no
    // `./auth`, no `pg` and no Next import, so nothing in it can grant anything.
    // The action catalogue above *names* which acts are determinations; the
    // routes are what enforce them.
    const source = readFileSync(new URL("./agency-commercial.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./digits", "./service-invoice"]);
    expect(source).not.toContain("from \"pg\"");
    expect(source).not.toContain("next/");
  });
});
