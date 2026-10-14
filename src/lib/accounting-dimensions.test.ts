import { describe, expect, it } from "vitest";
import {
  DETAIL_DIMENSION_DEFAULT_LABEL,
  DIMENSION_CODE_FIELD,
  DIMENSION_COLUMN,
  DIMENSION_KINDS,
  UNASSIGNED_DIMENSION,
  dimensionIdsByKind,
  dimensionKindLabel,
  dimensionLabelProblem,
  dimensionPostingFailure,
  dimensionValueProblem,
  isDimensionKind,
  naturalAmount,
  parseDimensionFilter,
  parseEffectiveDate,
  parseLineDimensions,
  resolveDimensionCode,
  type DimensionKind,
  type DimensionValueFacts,
} from "./accounting-dimensions";

const CC = "11111111-1111-4111-8111-111111111111";
const PC = "22222222-2222-4222-8222-222222222222";
const BRANCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRANCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEPT = "33333333-3333-4333-8333-333333333333";

function value(overrides: Partial<DimensionValueFacts> & { id: string; kind: DimensionKind }): DimensionValueFacts {
  return {
    isActive: true,
    locationId: null,
    effectiveFrom: null,
    effectiveTo: null,
    hasChildren: false,
    ...overrides,
  };
}

function facts(overrides: Partial<Parameters<typeof dimensionPostingFailure>[0]> = {}) {
  return {
    entryLocationId: BRANCH_A,
    entryDate: "2026-10-09",
    enabledKinds: new Set<DimensionKind>(["cost_center", "profit_center", "department", "detail"]),
    values: new Map<string, DimensionValueFacts>([
      [CC, value({ id: CC, kind: "cost_center" })],
      [PC, value({ id: PC, kind: "profit_center" })],
      [DEPT, value({ id: DEPT, kind: "department" })],
    ]),
    lines: [{ dimensions: { cost_center: CC } }],
    ...overrides,
  };
}

describe("kinds and labels", () => {
  it("knows exactly the four kinds and nothing else", () => {
    expect([...DIMENSION_KINDS]).toEqual(["cost_center", "profit_center", "department", "detail"]);
    for (const kind of DIMENSION_KINDS) expect(isDimensionKind(kind)).toBe(true);
    expect(isDimensionKind("project")).toBe(false);
    expect(isDimensionKind("branch")).toBe(false);
    expect(isDimensionKind(undefined)).toBe(false);
  });

  it("stores each kind in its own column, one per kind", () => {
    expect(new Set(Object.values(DIMENSION_COLUMN)).size).toBe(4);
    expect(DIMENSION_COLUMN.cost_center).toBe("cost_center_id");
    expect(DIMENSION_COLUMN.detail).toBe("detail_dimension_id");
  });

  it("names the detail kind by the business's own label, falling back to the default", () => {
    expect(dimensionKindLabel("detail", "پروژه‌های داخلی")).toBe("پروژه‌های داخلی");
    expect(dimensionKindLabel("detail", "   ")).toBe(DETAIL_DIMENSION_DEFAULT_LABEL);
    expect(dimensionKindLabel("detail", null)).toBe(DETAIL_DIMENSION_DEFAULT_LABEL);
  });

  it("ignores a stored label for the fixed kinds, which the product names", () => {
    expect(dimensionKindLabel("cost_center", "anything")).toBe("مرکز هزینه");
    expect(dimensionKindLabel("profit_center", null)).toBe("مرکز سود");
  });
});

describe("value records", () => {
  const ok = { code: "CC-100", name: "فروش", effectiveFrom: null, effectiveTo: null };

  it("accepts a plain record", () => {
    expect(dimensionValueProblem(ok)).toBeNull();
  });

  it("requires a code once surrounding spaces are removed", () => {
    expect(dimensionValueProblem({ ...ok, code: "   " })).toBe("code_required");
  });

  it("caps the code length and forbids characters that break a sheet or a CSV", () => {
    expect(dimensionValueProblem({ ...ok, code: "x".repeat(32) })).toBeNull();
    expect(dimensionValueProblem({ ...ok, code: "x".repeat(33) })).toBe("code_too_long");
    expect(dimensionValueProblem({ ...ok, code: "A,B" })).toBe("code_invalid");
    expect(dimensionValueProblem({ ...ok, code: 'A"B' })).toBe("code_invalid");
    expect(dimensionValueProblem({ ...ok, code: "A\nB" })).toBe("code_invalid");
  });

  it("requires a name and caps it", () => {
    expect(dimensionValueProblem({ ...ok, name: "  " })).toBe("name_required");
    expect(dimensionValueProblem({ ...ok, name: "n".repeat(160) })).toBeNull();
    expect(dimensionValueProblem({ ...ok, name: "n".repeat(161) })).toBe("name_too_long");
  });

  it("refuses an effective window that ends before it starts, and accepts a one-day window", () => {
    expect(
      dimensionValueProblem({ ...ok, effectiveFrom: "2026-10-09", effectiveTo: "2026-10-08" }),
    ).toBe("invalid_effective_dates");
    expect(dimensionValueProblem({ ...ok, effectiveFrom: "2026-10-09", effectiveTo: "2026-10-09" })).toBeNull();
    expect(dimensionValueProblem({ ...ok, effectiveFrom: null, effectiveTo: "2026-10-08" })).toBeNull();
  });

  it("validates the detail label on its own", () => {
    expect(dimensionLabelProblem("  ")).toBe("label_required");
    expect(dimensionLabelProblem("ب".repeat(80))).toBeNull();
    expect(dimensionLabelProblem("ب".repeat(81))).toBe("label_too_long");
  });

  it("reads effective dates as real calendar days, and treats blank as absent", () => {
    expect(parseEffectiveDate("2026-10-09")).toEqual({ ok: true, value: "2026-10-09" });
    expect(parseEffectiveDate("")).toEqual({ ok: true, value: null });
    expect(parseEffectiveDate(null)).toEqual({ ok: true, value: null });
    expect(parseEffectiveDate("2026-02-31")).toEqual({ ok: false });
    expect(parseEffectiveDate("09/10/2026")).toEqual({ ok: false });
    expect(parseEffectiveDate(20261009)).toEqual({ ok: false });
  });
});

describe("parseLineDimensions", () => {
  it("treats a missing object as no attribution", () => {
    expect(parseLineDimensions(undefined)).toEqual({ ok: true, value: {} });
    expect(parseLineDimensions(null)).toEqual({ ok: true, value: {} });
  });

  it("accepts UUIDs and explicit nulls for the four kinds", () => {
    expect(parseLineDimensions({ cost_center: CC, profit_center: null, department: DEPT })).toEqual({
      ok: true,
      value: { cost_center: CC, profit_center: null, department: DEPT },
    });
  });

  it("refuses an unknown key, a non-UUID value, a number, or an array, rather than dropping them", () => {
    expect(parseLineDimensions({ project: CC })).toEqual({ ok: false });
    expect(parseLineDimensions({ cost_center: "cc-1" })).toEqual({ ok: false });
    expect(parseLineDimensions({ cost_center: 42 })).toEqual({ ok: false });
    expect(parseLineDimensions({ cost_center: "" })).toEqual({ ok: false });
    expect(parseLineDimensions([CC])).toEqual({ ok: false });
    expect(parseLineDimensions("cost_center")).toEqual({ ok: false });
  });
});

describe("dimensionIdsByKind", () => {
  it("collects distinct non-empty ids per kind across every line", () => {
    const ids = dimensionIdsByKind([
      { dimensions: { cost_center: CC, profit_center: PC } },
      { dimensions: { cost_center: CC, profit_center: null } },
      { dimensions: undefined },
      { dimensions: { department: DEPT } },
    ]);
    expect(ids.cost_center).toEqual([CC]);
    expect(ids.profit_center).toEqual([PC]);
    expect(ids.department).toEqual([DEPT]);
    expect(ids.detail).toEqual([]);
  });
});

describe("dimensionPostingFailure — the policy a new posting is held to", () => {
  it("passes a document that carries no attribution at all", () => {
    expect(dimensionPostingFailure(facts({ lines: [{}, { dimensions: {} }] }))).toBeNull();
  });

  it("passes a usable value of every kind", () => {
    expect(
      dimensionPostingFailure(facts({ lines: [{ dimensions: { cost_center: CC, profit_center: PC, department: DEPT } }] })),
    ).toBeNull();
  });

  it("refuses a value that is not in this business's set", () => {
    const failure = dimensionPostingFailure(facts({ lines: [{ dimensions: { cost_center: DEPT } }] }));
    // DEPT is in the map as a department, so putting it in the cost-centre slot is a kind mismatch.
    expect(failure).toMatchObject({ problem: "dimension_kind_mismatch", kind: "cost_center", lineIndex: 0 });
    expect(
      dimensionPostingFailure(facts({ lines: [{ dimensions: { cost_center: "99999999-9999-4999-8999-999999999999" } }] })),
    ).toMatchObject({ problem: "dimension_not_found" });
  });

  it("refuses a kind the business has not switched on, and says which line", () => {
    const failure = dimensionPostingFailure(
      facts({
        enabledKinds: new Set<DimensionKind>(["cost_center"]),
        lines: [{ dimensions: { cost_center: CC } }, { dimensions: { profit_center: PC } }],
      }),
    );
    expect(failure).toEqual({ problem: "dimension_kind_disabled", kind: "profit_center", valueId: PC, lineIndex: 1 });
  });

  it("refuses an archived value for a new posting", () => {
    const values = new Map([[CC, value({ id: CC, kind: "cost_center", isActive: false })]]);
    expect(dimensionPostingFailure(facts({ values }))).toMatchObject({ problem: "dimension_inactive" });
  });

  it("refuses a parent: a value with children is a rollup, and a rollup is never a posting target", () => {
    const values = new Map([[CC, value({ id: CC, kind: "cost_center", hasChildren: true })]]);
    expect(dimensionPostingFailure(facts({ values }))).toMatchObject({ problem: "dimension_not_leaf" });
  });

  it("holds a branch-restricted value to its own branch only", () => {
    const values = new Map([[CC, value({ id: CC, kind: "cost_center", locationId: BRANCH_A })]]);
    expect(dimensionPostingFailure(facts({ values, entryLocationId: BRANCH_A }))).toBeNull();
    expect(dimensionPostingFailure(facts({ values, entryLocationId: BRANCH_B }))).toMatchObject({
      problem: "dimension_branch_mismatch",
    });
    // A business-wide entry (no branch) cannot use a value that belongs to one branch.
    expect(dimensionPostingFailure(facts({ values, entryLocationId: null }))).toMatchObject({
      problem: "dimension_branch_mismatch",
    });
  });

  it("lets a business-wide value be used from any branch, and from none", () => {
    const values = new Map([[CC, value({ id: CC, kind: "cost_center", locationId: null })]]);
    expect(dimensionPostingFailure(facts({ values, entryLocationId: BRANCH_B }))).toBeNull();
    expect(dimensionPostingFailure(facts({ values, entryLocationId: null }))).toBeNull();
  });

  it("keeps a value outside its effective window closed, and includes both boundary days", () => {
    const values = new Map([
      [CC, value({ id: CC, kind: "cost_center", effectiveFrom: "2026-10-01", effectiveTo: "2026-10-31" })],
    ]);
    expect(dimensionPostingFailure(facts({ values, entryDate: "2026-10-01" }))).toBeNull();
    expect(dimensionPostingFailure(facts({ values, entryDate: "2026-10-31" }))).toBeNull();
    expect(dimensionPostingFailure(facts({ values, entryDate: "2026-09-30" }))).toMatchObject({
      problem: "dimension_not_effective",
    });
    expect(dimensionPostingFailure(facts({ values, entryDate: "2026-11-01" }))).toMatchObject({
      problem: "dimension_not_effective",
    });
  });

  it("reports the first failure in line order", () => {
    const values = new Map([
      [CC, value({ id: CC, kind: "cost_center", isActive: false })],
      [PC, value({ id: PC, kind: "profit_center", isActive: false })],
    ]);
    const failure = dimensionPostingFailure(facts({ values, lines: [{}, { dimensions: { cost_center: CC } }, { dimensions: { profit_center: PC } }] }));
    expect(failure).toMatchObject({ problem: "dimension_inactive", valueId: CC, lineIndex: 1 });
  });
});

describe("resolveDimensionCode — imports map or refuse, never invent", () => {
  const values = [
    { id: CC, code: "CC-01", isActive: true },
    { id: PC, code: "ONLINE", isActive: false },
  ];

  it("maps a code ignoring case and surrounding spaces", () => {
    expect(resolveDimensionCode("  cc-01 ", values)).toEqual({ status: "resolved", valueId: CC });
  });

  it("reports an archived code as inactive, not as resolved", () => {
    expect(resolveDimensionCode("online", values)).toEqual({ status: "inactive", valueId: PC });
  });

  it("refuses an unknown or blank code rather than creating or dropping it", () => {
    expect(resolveDimensionCode("NOPE", values)).toEqual({ status: "unknown" });
    expect(resolveDimensionCode("   ", values)).toEqual({ status: "unknown" });
  });
});

describe("DIMENSION_CODE_FIELD — the sheet column each kind is read from", () => {
  it("names the four columns the registry declares and the adapter reads", () => {
    expect(DIMENSION_CODE_FIELD).toEqual({
      cost_center: "costCenterCode",
      profit_center: "profitCenterCode",
      department: "departmentCode",
      detail: "detailCode",
    });
  });

  it("covers every kind, so no dimension can be posted from a sheet by accident of a missing key", () => {
    expect(Object.keys(DIMENSION_CODE_FIELD).sort()).toEqual([...DIMENSION_KINDS].sort());
  });
});

describe("parseDimensionFilter", () => {
  it("reads no filter as no filter", () => {
    expect(parseDimensionFilter(undefined, undefined)).toEqual({ ok: true, filter: null });
    expect(parseDimensionFilter("", "")).toEqual({ ok: true, filter: null });
  });

  it("reads a kind with one value, or with the unassigned sentinel", () => {
    expect(parseDimensionFilter("cost_center", CC)).toEqual({
      ok: true,
      filter: { kind: "cost_center", valueId: CC },
    });
    expect(parseDimensionFilter("profit_center", UNASSIGNED_DIMENSION)).toEqual({
      ok: true,
      filter: { kind: "profit_center", valueId: UNASSIGNED_DIMENSION },
    });
  });

  it("refuses a half-filter, an unknown kind, or a value that is not an id", () => {
    expect(parseDimensionFilter("cost_center", undefined)).toEqual({ ok: false });
    expect(parseDimensionFilter(undefined, CC)).toEqual({ ok: false });
    expect(parseDimensionFilter("project", CC)).toEqual({ ok: false });
    expect(parseDimensionFilter("cost_center", "CC-01")).toEqual({ ok: false });
  });
});

describe("naturalAmount — the sign a report shows", () => {
  it("is positive on the account's own side and negative on the other", () => {
    expect(naturalAmount(1_500_000, 0, "debit")).toBe(1_500_000n);
    expect(naturalAmount(0, 1_500_000, "debit")).toBe(-1_500_000n);
    expect(naturalAmount(0, 2_000_000, "credit")).toBe(2_000_000n);
    expect(naturalAmount(300, 1_200, "credit")).toBe(900n);
  });

  it("keeps amounts beyond Number's safe range exact", () => {
    const big = 9_007_199_254_740_993n;
    expect(naturalAmount(big, 0n, "debit")).toBe(big);
    expect(naturalAmount(big, 1n, "debit")).toBe(big - 1n);
  });
});
