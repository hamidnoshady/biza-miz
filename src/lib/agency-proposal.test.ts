import { describe, expect, it } from "vitest";

import {
  AGENCY_PROPOSAL_ACTIONS,
  AGENCY_PROPOSAL_ACTION_LABELS,
  AGENCY_PROPOSAL_LINE_LIMIT,
  AGENCY_PROPOSAL_REVENUE_ACCOUNTS,
  AGENCY_PROPOSAL_STATUSES,
  AGENCY_PROPOSAL_STATUS_LABELS,
  AGENCY_PROPOSAL_STATUS_TONES,
  agencyProposalActionBlocked,
  agencyProposalActionsFrom,
  agencyProposalActionTarget,
  agencyProposalClientLines,
  agencyProposalClientView,
  agencyProposalDecisionNeedsName,
  agencyProposalDiscountAllowed,
  agencyProposalLineAmountRial,
  agencyProposalMargin,
  agencyProposalTotals,
  canPerformAgencyProposalAction,
  canTransitionAgencyProposal,
  defaultAgencyProposalRevenueCode,
  isAgencyProposalAction,
  isAgencyProposalDeletable,
  isAgencyProposalEditable,
  isAgencyProposalFrozen,
  isAgencyProposalLapsed,
  isAgencyProposalOpen,
  isAgencyProposalRevenueCode,
  isAgencyProposalStatus,
  normalizeAgencyProposalDate,
  normalizeAgencyProposalLines,
  normalizeAgencyProposalQuantity,
  normalizeAgencyProposalRial,
  normalizeAgencyProposalText,
  type AgencyProposalLine,
} from "./agency-proposal";

const line = (over: Partial<AgencyProposalLine> = {}): AgencyProposalLine => ({
  id: "11111111-1111-1111-1111-111111111111",
  lineNumber: 1,
  description: "Campaign management",
  quantity: 1,
  unitPriceRial: 1_000,
  amountRial: 1_000,
  revenueCode: "4640",
  costRial: null,
  passThrough: false,
  note: "",
  ...over,
});

describe("status vocabulary", () => {
  it("labels and tones cover every status", () => {
    // A Record<> makes this a compile error, and this makes it a runtime one too:
    // the type is only as exhaustive as the last person who edited both files.
    expect(Object.keys(AGENCY_PROPOSAL_STATUS_LABELS).sort()).toEqual(
      [...AGENCY_PROPOSAL_STATUSES].sort(),
    );
    expect(Object.keys(AGENCY_PROPOSAL_STATUS_TONES).sort()).toEqual(
      [...AGENCY_PROPOSAL_STATUSES].sort(),
    );
    expect(Object.keys(AGENCY_PROPOSAL_ACTION_LABELS).sort()).toEqual(
      [...AGENCY_PROPOSAL_ACTIONS].sort(),
    );
  });

  it("accepts its own statuses and actions and nothing else", () => {
    for (const status of AGENCY_PROPOSAL_STATUSES) expect(isAgencyProposalStatus(status)).toBe(true);
    for (const action of AGENCY_PROPOSAL_ACTIONS) expect(isAgencyProposalAction(action)).toBe(true);
    expect(isAgencyProposalStatus("signed")).toBe(false);
    expect(isAgencyProposalStatus(undefined)).toBe(false);
    expect(isAgencyProposalAction(7)).toBe(false);
  });
});

describe("the chain", () => {
  it("runs draft → sent → a decision, and every decision is terminal", () => {
    expect(canTransitionAgencyProposal("draft", "sent")).toBe(true);
    expect(canTransitionAgencyProposal("sent", "accepted")).toBe(true);
    expect(canTransitionAgencyProposal("sent", "declined")).toBe(true);
    expect(canTransitionAgencyProposal("sent", "expired")).toBe(true);
    expect(agencyProposalActionsFrom("accepted")).toEqual([]);
    expect(agencyProposalActionsFrom("declined")).toEqual([]);
    expect(agencyProposalActionsFrom("expired")).toEqual([]);
  });

  it("never lets a decision be revised in place", () => {
    // The correction is a new proposal in the series. Reopening a declined offer
    // would destroy the only record of what the client said no to.
    expect(canTransitionAgencyProposal("declined", "accepted")).toBe(false);
    expect(canTransitionAgencyProposal("accepted", "declined")).toBe(false);
    expect(canTransitionAgencyProposal("accepted", "draft")).toBe(false);
    expect(canTransitionAgencyProposal("expired", "sent")).toBe(false);
  });

  it("lets a withdrawn offer be reopened, as a withdrawn brief may", () => {
    expect(canTransitionAgencyProposal("withdrawn", "draft")).toBe(true);
    expect(agencyProposalActionsFrom("withdrawn")).toEqual(["reopen"]);
  });

  it("derives the panel's buttons from the chain, so none can be unanswerable", () => {
    expect(agencyProposalActionsFrom("draft")).toEqual(["send", "withdraw"]);
    expect(agencyProposalActionsFrom("sent")).toEqual([
      "withdraw",
      "accept",
      "decline",
      "expire",
    ]);
    for (const status of AGENCY_PROPOSAL_STATUSES) {
      for (const action of agencyProposalActionsFrom(status)) {
        expect(canPerformAgencyProposalAction(status, action)).toBe(true);
        expect(isAgencyProposalStatus(agencyProposalActionTarget(action))).toBe(true);
      }
    }
  });

  it("freezes everything past draft, and says so separately about the lines", () => {
    expect(isAgencyProposalFrozen("draft")).toBe(false);
    for (const status of AGENCY_PROPOSAL_STATUSES) {
      if (status === "draft") continue;
      expect(isAgencyProposalFrozen(status)).toBe(true);
    }
    expect(isAgencyProposalEditable("draft")).toBe(true);
    expect(isAgencyProposalEditable("sent")).toBe(false);
    expect(isAgencyProposalDeletable("draft")).toBe(true);
    expect(isAgencyProposalDeletable("accepted")).toBe(false);
    expect(isAgencyProposalOpen("sent")).toBe(true);
    expect(isAgencyProposalOpen("expired")).toBe(false);
  });

  it("needs a name for both decisions, and for neither of the others", () => {
    expect(agencyProposalDecisionNeedsName("accept")).toBe(true);
    expect(agencyProposalDecisionNeedsName("decline")).toBe(true);
    expect(agencyProposalDecisionNeedsName("send")).toBe(false);
    expect(agencyProposalDecisionNeedsName("expire")).toBe(false);
    expect(agencyProposalDecisionNeedsName("withdraw")).toBe(false);
    expect(agencyProposalDecisionNeedsName("reopen")).toBe(false);
  });
});

describe("validity", () => {
  const sent = "sent" as const;

  it("lapses the day after valid_until, not on it", () => {
    // Inclusive: an offer "valid until 1 March" is still an offer on 1 March.
    expect(isAgencyProposalLapsed(sent, "2027-03-01", new Date("2027-03-01T09:00:00Z"))).toBe(false);
    expect(isAgencyProposalLapsed(sent, "2027-03-01", new Date("2027-03-01T23:59:59Z"))).toBe(false);
    expect(isAgencyProposalLapsed(sent, "2027-03-01", new Date("2027-03-02T00:00:00Z"))).toBe(true);
  });

  it("does not lapse a decided offer, however old the date", () => {
    // `expired` is a decision somebody recorded; lapsing is a fact about a live
    // offer's date. Telling a member an accepted proposal has lapsed is noise.
    for (const status of ["accepted", "declined", "expired", "withdrawn", "draft"] as const) {
      expect(isAgencyProposalLapsed(status, "2020-01-01", new Date("2027-03-02T00:00:00Z"))).toBe(
        false,
      );
    }
  });

  it("does not lapse an offer with no clock on it", () => {
    expect(isAgencyProposalLapsed(sent, null, new Date("2099-01-01T00:00:00Z"))).toBe(false);
    expect(isAgencyProposalLapsed(sent, "not a date", new Date("2099-01-01T00:00:00Z"))).toBe(false);
  });

  it("blocks accepting a lapsed offer and nothing else", () => {
    const past = new Date("2027-06-01T00:00:00Z");
    expect(agencyProposalActionBlocked("accept", sent, "2027-03-01", past)).toBe("proposal_lapsed");
    // Recording a decline or closing an expired offer are accurate statements
    // about the past, so neither is blocked.
    expect(agencyProposalActionBlocked("decline", sent, "2027-03-01", past)).toBeNull();
    expect(agencyProposalActionBlocked("expire", sent, "2027-03-01", past)).toBeNull();
    expect(agencyProposalActionBlocked("withdraw", sent, "2027-03-01", past)).toBeNull();
    expect(agencyProposalActionBlocked("accept", sent, "2027-09-01", past)).toBeNull();
    expect(agencyProposalActionBlocked("accept", sent, null, past)).toBeNull();
  });
});

describe("revenue accounts", () => {
  it("reads the trade's own four, and defaults to the first", () => {
    // Restating these codes here would let the offer, the invoice screen and the
    // ledger drift apart — the split §D exists to keep.
    expect(AGENCY_PROPOSAL_REVENUE_ACCOUNTS.map((a) => a.code)).toEqual([
      "4640",
      "4650",
      "4660",
      "4670",
    ]);
    expect(defaultAgencyProposalRevenueCode()).toBe("4640");
    for (const account of AGENCY_PROPOSAL_REVENUE_ACCOUNTS) {
      expect(isAgencyProposalRevenueCode(account.code)).toBe(true);
    }
    expect(isAgencyProposalRevenueCode("4680")).toBe(false);
    expect(isAgencyProposalRevenueCode(4640)).toBe(false);
  });
});

describe("the amount, which must agree with the trigger", () => {
  it("rounds half up, exactly as Postgres rounds numeric", () => {
    expect(agencyProposalLineAmountRial(1.5, 1_000)).toBe(1_500);
    expect(agencyProposalLineAmountRial(0.5, 1_001)).toBe(501);
    expect(agencyProposalLineAmountRial(0.25, 4_000)).toBe(1_000);
    expect(agencyProposalLineAmountRial(1, 0)).toBe(0);
  });
});

describe("normalisation", () => {
  it("trims text and refuses what is too long rather than cutting it", () => {
    expect(normalizeAgencyProposalText("  scope  ", 100)).toBe("scope");
    expect(normalizeAgencyProposalText(undefined, 100)).toBe("");
    expect(normalizeAgencyProposalText(null, 100)).toBe("");
    expect(normalizeAgencyProposalText("x".repeat(11), 10)).toBeNull();
    expect(normalizeAgencyProposalText(7, 10)).toBeNull();
  });

  it("keeps zero as a real rial figure, and refuses a negative one", () => {
    // Collapsing zero into absent would make "no discount" and "not stated"
    // indistinguishable in the one place the difference matters.
    expect(normalizeAgencyProposalRial(0, 1000)).toBe(0);
    expect(normalizeAgencyProposalRial("0", 1000)).toBe(0);
    expect(normalizeAgencyProposalRial(undefined, 1000)).toBeNull();
    expect(normalizeAgencyProposalRial("", 1000)).toBeNull();
    expect(normalizeAgencyProposalRial(-1, 1000)).toBeNull();
    expect(normalizeAgencyProposalRial(1001, 1000)).toBeNull();
    expect(normalizeAgencyProposalRial("2500", 10000)).toBe(2500);
    expect(normalizeAgencyProposalRial(Number.NaN, 1000)).toBeNull();
  });

  it("accepts fractional quantities and defaults an absent one to 1", () => {
    expect(normalizeAgencyProposalQuantity(undefined)).toBe(1);
    expect(normalizeAgencyProposalQuantity(1.5)).toBe(1.5);
    expect(normalizeAgencyProposalQuantity("0.25")).toBe(0.25);
    // A browser's floating-point artefact is not the member's error to fix.
    expect(normalizeAgencyProposalQuantity(0.1 + 0.2)).toBe(0.3);
    expect(normalizeAgencyProposalQuantity(0)).toBeNull();
    expect(normalizeAgencyProposalQuantity(-1)).toBeNull();
    expect(normalizeAgencyProposalQuantity(10_001)).toBeNull();
    expect(normalizeAgencyProposalQuantity("abc")).toBeNull();
  });

  it("accepts only a plain date, so a timestamp cannot be silently truncated", () => {
    expect(normalizeAgencyProposalDate("2027-03-01")).toBe("2027-03-01");
    expect(normalizeAgencyProposalDate(" 2027-03-01 ")).toBe("2027-03-01");
    expect(normalizeAgencyProposalDate(undefined)).toBeNull();
    expect(normalizeAgencyProposalDate("")).toBeNull();
    expect(normalizeAgencyProposalDate("2027-03-01T10:00:00Z")).toBeNull();
    expect(normalizeAgencyProposalDate(20270301)).toBeNull();
    // A date that parses but does not exist would silently become another day.
    expect(normalizeAgencyProposalDate("2027-02-30")).toBeNull();
    // A Jalali year has the same shape as a Gregorian one and would store as the
    // year 1406 — an offer that lapsed six centuries ago, with every acceptance
    // of it refused and nothing on screen to say why.
    expect(normalizeAgencyProposalDate("1406-03-01")).toBeNull();
    expect(normalizeAgencyProposalDate("1899-12-31")).toBeNull();
    expect(normalizeAgencyProposalDate("2201-01-01")).toBeNull();
    expect(normalizeAgencyProposalDate("1970-01-01")).toBe("1970-01-01");
  });
});

describe("lines", () => {
  it("renumbers in the order given, because line_number is the printed order", () => {
    const out = normalizeAgencyProposalLines([
      { description: "Second", unitPriceRial: 2 },
      { description: "First", unitPriceRial: 1 },
    ]);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    // The array's shape, not a value the caller owns: a body that numbered its
    // own lines could produce two lines both called 3.
    expect(out?.map((l) => l.description)).toEqual(["Second", "First"]);
  });

  it("fills the defaults a caller may legitimately omit", () => {
    const out = normalizeAgencyProposalLines([{ description: "Media" }]);
    expect(out?.[0]).toEqual({
      description: "Media",
      quantity: 1,
      unitPriceRial: 0,
      revenueCode: "4640",
      costRial: null,
      passThrough: false,
      note: "",
    });
  });

  it("returns null rather than dropping a line it cannot use", () => {
    // An offer that silently lost a line would understate its own price, and the
    // member would send it believing it was complete.
    expect(normalizeAgencyProposalLines("nope")).toBeNull();
    expect(normalizeAgencyProposalLines([null])).toBeNull();
    expect(normalizeAgencyProposalLines([{ description: "  " }])).toBeNull();
    expect(normalizeAgencyProposalLines([{ description: "x", quantity: 0 }])).toBeNull();
    expect(normalizeAgencyProposalLines([{ description: "x", unitPriceRial: -5 }])).toBeNull();
    expect(normalizeAgencyProposalLines([{ description: "x", revenueCode: "4680" }])).toBeNull();
    expect(normalizeAgencyProposalLines([{ description: "x", passThrough: "yes" }])).toBeNull();
  });

  it("refuses a pass-through line that does not state what passes through", () => {
    expect(normalizeAgencyProposalLines([{ description: "x", passThrough: true }])).toBeNull();
    expect(
      normalizeAgencyProposalLines([{ description: "x", passThrough: true, costRial: 0 }]),
    ).not.toBeNull();
  });

  it("refuses more lines than an offer can carry", () => {
    const many = Array.from({ length: AGENCY_PROPOSAL_LINE_LIMIT }, (_, i) => ({
      description: "Line " + i,
    }));
    expect(normalizeAgencyProposalLines(many)).toHaveLength(AGENCY_PROPOSAL_LINE_LIMIT);
    expect(normalizeAgencyProposalLines([...many, { description: "One too many" }])).toBeNull();
  });

  it("treats an absent list as no lines, not as an error", () => {
    expect(normalizeAgencyProposalLines(undefined)).toEqual([]);
    expect(normalizeAgencyProposalLines(null)).toEqual([]);
  });
});

describe("totals, which nothing stores", () => {
  it("derives the subtotal from the lines and taxes what is left after discount", () => {
    const totals = agencyProposalTotals(
      [line({ amountRial: 1_000 }), line({ amountRial: 500 })],
      300,
      100,
    );
    expect(totals).toEqual({ subtotalRial: 1_500, discountRial: 300, taxRial: 100, totalRial: 1_300 });
  });

  it("caps a discount at the subtotal, so an offer can never go negative", () => {
    const totals = agencyProposalTotals([line({ amountRial: 1_000 })], 5_000, 0);
    expect(totals.discountRial).toBe(1_000);
    expect(totals.totalRial).toBe(0);
  });

  it("says whether a discount is allowed, and permits a free offer", () => {
    expect(agencyProposalDiscountAllowed(1_000, 1_000)).toBe(true);
    expect(agencyProposalDiscountAllowed(1_000, 1_001)).toBe(false);
    expect(agencyProposalDiscountAllowed(1_000, -1)).toBe(false);
    expect(agencyProposalDiscountAllowed(0, 0)).toBe(true);
  });

  it("totals an empty offer as zero rather than as an error", () => {
    expect(agencyProposalTotals([], 0, 0)).toEqual({
      subtotalRial: 0,
      discountRial: 0,
      taxRial: 0,
      totalRial: 0,
    });
  });
});

describe("margin — internal", () => {
  it("subtracts the discount but never the tax, because tax is collected not earned", () => {
    const margin = agencyProposalMargin(
      [line({ amountRial: 1_000, costRial: 400 }), line({ amountRial: 500, costRial: 100 })],
      300,
      200,
    );
    // 1500 subtotal − 300 discount − 500 cost. Including the 200 of tax on
    // either side would inflate every margin by the same dishonest amount.
    expect(margin.costRial).toBe(500);
    expect(margin.marginRial).toBe(700);
    expect(margin.totalRial).toBe(1_400);
    expect(margin.costedLineCount).toBe(2);
    expect(margin.lineCount).toBe(2);
  });

  it("counts an uncosted line as costing nothing, and says how many were costed", () => {
    const margin = agencyProposalMargin(
      [line({ amountRial: 1_000, costRial: 250 }), line({ amountRial: 900, costRial: null })],
      0,
      0,
    );
    expect(margin.costRial).toBe(250);
    expect(margin.costedLineCount).toBe(1);
    expect(margin.lineCount).toBe(2);
    // A margin over a half-costed offer is a guess, and the count is what tells
    // the screen to say so rather than print a confident figure.
    expect(margin.costedLineCount).toBeLessThan(margin.lineCount);
  });

  it("separates the client's money passing through from the agency's own revenue", () => {
    const margin = agencyProposalMargin(
      [
        line({ amountRial: 1_000, costRial: 200, passThrough: false }),
        line({ amountRial: 4_000, costRial: 4_000, passThrough: true }),
      ],
      0,
      0,
    );
    expect(margin.passThroughRial).toBe(4_000);
    expect(margin.marginRial).toBe(800);
    expect(margin.subtotalRial).toBe(5_000);
  });

  it("agrees with the client totals it extends, so the two cannot drift", () => {
    const lines = [line({ amountRial: 700, costRial: 100 }), line({ amountRial: 300 })];
    const totals = agencyProposalTotals(lines, 100, 50);
    const margin = agencyProposalMargin(lines, 100, 50);
    expect({
      subtotalRial: margin.subtotalRial,
      discountRial: margin.discountRial,
      taxRial: margin.taxRial,
      totalRial: margin.totalRial,
    }).toEqual(totals);
  });
});

describe("the client boundary", () => {
  it("cannot name a cost, a pass-through or an account code", () => {
    // The rule is structural: the fields are absent from the returned object, so
    // a screen built on this projection cannot render what it cannot name. A
    // comment saying "do not show the cost" survives one refactor; this does not
    // need to.
    const out = agencyProposalClientLines([
      line({ costRial: 400, passThrough: true, revenueCode: "4660", note: "buy" }),
    ]);
    expect(Object.keys(out[0]).sort()).toEqual([
      "amountRial",
      "description",
      "lineNumber",
      "note",
      "quantity",
      "unitPriceRial",
    ]);
    expect(JSON.stringify(out)).not.toContain("cost");
    expect(JSON.stringify(out)).not.toContain("passThrough");
    expect(JSON.stringify(out)).not.toContain("4660");
    // The value the client is entitled to survives the projection unchanged.
    expect(out[0].note).toBe("buy");
    expect(out[0].amountRial).toBe(1_000);
  });

  it("projects an offer without the agency's record of what happened to it", () => {
    const view = agencyProposalClientView(
      {
        proposalNumber: "PR-001",
        title: "Spring campaign",
        scopeOfWork: "Three channels, six weeks.",
        terms: "Half up front.",
        validUntilIso: "2027-03-01",
        discountRial: 0,
        taxRial: 0,
        clientName: "Client A",
        agencyName: "Agency A",
      },
      [line({ amountRial: 1_000, costRial: 400 }), line({ lineNumber: 2, amountRial: 500 })],
    );
    expect(view.proposalNumber).toBe("PR-001");
    expect(view.lines).toHaveLength(2);
    expect(view.totals.totalRial).toBe(1_500);
    // `status` is absent on purpose: a print template renders the offer, and a
    // quote marked «ردشده» would be a document the client never saw.
    expect("status" in view).toBe(false);
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain("costRial");
    expect(dumped).not.toContain("passThrough");
    expect(dumped).not.toContain("revenueCode");
    expect(dumped).not.toContain("400");
  });
});
