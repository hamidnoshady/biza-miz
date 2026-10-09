/**
 * «ابعاد حسابداری» — accounting dimensions (issue #868) as pure rules.
 *
 * A dimension tells a journal line *whose* money it is: which cost centre
 * carries the expense, which profit centre earns the revenue, which department
 * or configurable detail it belongs to. The screens (`accounting/dimensions`,
 * the manual-entry lines, the expense form, the report filters), the services
 * that post (`accounting-dimensions-service.ts`, `ledger-service.ts`,
 * `manual-journal-service.ts`, `expense-service.ts`) and the importers all have
 * to agree on what a dimension is and when it may be used. So those rules live
 * here once, framework-free, and every side imports them — the same reason
 * `manual-journal.ts` exists for manual documents.
 *
 * ## The model (ISSUE_868_PLAN.md §1)
 *
 *   * Attribution is per journal LINE. `journal_lines` carries four nullable
 *     columns, one per kind, and a line carries at most one value of each kind.
 *   * Project and branch are NOT dimensions. They stay on the journal entry
 *     header (`project_id`, `location_id`) and are never copied into a line, so
 *     a project is never duplicated as a cost centre and a branch is never
 *     duplicated as a profit centre.
 *   * A report groups by ONE kind at a time, or filters by any number of kinds
 *     at once (AND). Summing two groupings of different kinds would double
 *     count, so no report is written that way.
 *
 * DB-free by design, so `accounting-dimensions.test.ts` covers the policy with
 * plain fixtures (CLAUDE.md: a change under `src/lib/` needs a matching unit
 * test).
 */
import { normalizeOptionalIsoDate } from "./iso-date";

/** The four kinds, in the order a person meets them on screen. */
export const DIMENSION_KINDS = ["cost_center", "profit_center", "department", "detail"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

/** Persian names. `detail` is configurable per business; this is its default name. */
export const DIMENSION_KIND_LABELS: Record<DimensionKind, string> = {
  cost_center: "مرکز هزینه",
  profit_center: "مرکز سود",
  department: "واحد سازمانی",
  detail: "بعد تحلیلی",
};

export const DETAIL_DIMENSION_DEFAULT_LABEL = DIMENSION_KIND_LABELS.detail;

/**
 * What each kind is FOR, shown under its switch on the settings screen. The
 * point of the sentence is the distinction the issue insists on: a cost centre
 * is not a project, and a profit centre is not a branch.
 */
export const DIMENSION_KIND_DESCRIPTIONS: Record<DimensionKind, string> = {
  cost_center: "هزینه‌ها را به بخشی از کسب‌وکار نسبت می‌دهد، مثلاً «اجاره و نگهداری شعبهٔ مرکزی». پروژه‌ها جدا می‌مانند و مرکز هزینه نمی‌شوند.",
  profit_center: "درآمد و بهای تمام‌شدهٔ یک خط کاری را، فارغ از شعبه، جمع می‌کند، مثلاً «فروش آنلاین». شعبه‌ها جدا می‌مانند.",
  department: "هزینه و درآمد را به واحد سازمانی نسبت می‌دهد، مثلاً «فروش» یا «پشتیبانی».",
  detail: "یک بعد تحلیلی دلخواه که نام آن را خود کسب‌وکار تعیین می‌کند؛ برای نیازی که با سه بعد بالا پوشش داده نمی‌شود.",
};

/** The attribution column each kind is stored in, on `journal_lines`, `journal_entry_draft_lines` and `expenses`. */
export const DIMENSION_COLUMN: Record<DimensionKind, string> = {
  cost_center: "cost_center_id",
  profit_center: "profit_center_id",
  department: "department_id",
  detail: "detail_dimension_id",
};

/**
 * The import and export field each kind is written from on an expense sheet
 * (issue #868). The cell names a value's **code**, never its id, so a file can be
 * read and checked by a person. The registry declares these fields and the
 * adapter reads them through this map, so the two cannot drift apart silently.
 */
export const DIMENSION_CODE_FIELD: Record<DimensionKind, string> = {
  cost_center: "costCenterCode",
  profit_center: "profitCenterCode",
  department: "departmentCode",
  detail: "detailCode",
};

export const DIMENSION_CODE_MAX = 32;
export const DIMENSION_NAME_MAX = 160;
export const DIMENSION_LABEL_MAX = 80;

/**
 * One line's attribution: a value id per kind, or `null`/absent for none. This
 * is the shape a document carries across the API and into the services.
 */
export type LineDimensions = Partial<Record<DimensionKind, string | null>>;

/** The sentinel a report uses for «no value of this kind». Never a stored id. */
export const UNASSIGNED_DIMENSION = "unassigned" as const;

export function isDimensionKind(value: unknown): value is DimensionKind {
  return typeof value === "string" && (DIMENSION_KINDS as readonly string[]).includes(value);
}

/** The label a kind is shown with, honouring the business's own name for the detail kind. */
export function dimensionKindLabel(kind: DimensionKind, detailLabel?: string | null): string {
  if (kind === "detail") return detailLabel?.trim() || DETAIL_DIMENSION_DEFAULT_LABEL;
  return DIMENSION_KIND_LABELS[kind];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDimensionUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Value records
// ---------------------------------------------------------------------------

/** One kind's switch and name, as the API returns it and the settings screen draws it. */
export interface DimensionSettingRecord {
  kind: DimensionKind;
  isEnabled: boolean;
  /** The business's name for the detail kind; `null` for the fixed kinds and for the default. */
  label: string | null;
  defaultLabel: string;
  description: string;
}

/** One value record, as the API returns it. Dates are ISO `YYYY-MM-DD` on the wire, Shamsi on screen. */
export interface DimensionValueRecord {
  id: string;
  kind: DimensionKind;
  code: string;
  name: string;
  parentId: string | null;
  parentCode: string | null;
  parentName: string | null;
  locationId: string | null;
  locationName: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  hasChildren: boolean;
  createdAt: string;
  updatedAt: string;
}


export type DimensionValueProblem =
  | "code_required"
  | "code_too_long"
  | "code_invalid"
  | "name_required"
  | "name_too_long"
  | "invalid_effective_dates";

/**
 * A code is what a person types into an import sheet and reads on a report, so
 * it is short and free of the characters that break a spreadsheet cell or a CSV
 * export: no commas, quotes, or line breaks.
 */
const CODE_FORBIDDEN_RE = /[,"'\r\n\t]/;

export function normalizeDimensionCode(code: string): string {
  return code.trim();
}

/** The one definition of a valid value record, shared by the screen and the service. */
export function dimensionValueProblem(input: {
  code: string;
  name: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}): DimensionValueProblem | null {
  const code = normalizeDimensionCode(input.code);
  if (!code) return "code_required";
  if (code.length > DIMENSION_CODE_MAX) return "code_too_long";
  if (CODE_FORBIDDEN_RE.test(code)) return "code_invalid";
  const name = input.name.trim();
  if (!name) return "name_required";
  if (name.length > DIMENSION_NAME_MAX) return "name_too_long";
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    return "invalid_effective_dates";
  }
  return null;
}

/** The detail dimension's configurable name. Blank is a refusal, not a silent default. */
export function dimensionLabelProblem(label: string): "label_required" | "label_too_long" | null {
  const trimmed = label.trim();
  if (!trimmed) return "label_required";
  if (trimmed.length > DIMENSION_LABEL_MAX) return "label_too_long";
  return null;
}

export type DimensionDateParse = { ok: true; value: string | null } | { ok: false };

/** An optional effective date: ISO `YYYY-MM-DD`, a real calendar day, or absent. */
export function parseEffectiveDate(value: unknown): DimensionDateParse {
  return normalizeOptionalIsoDate(value);
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export type LineDimensionsParse = { ok: true; value: LineDimensions } | { ok: false };

/**
 * Reads one line's `dimensions` object from an untrusted body. Strict in the
 * same way `parseManualDraftPayload` is strict about amounts: an unknown key, a
 * value that is not a UUID or `null`, or an array is refused, never coerced. A
 * missing object means no attribution, which is the common case.
 */
export function parseLineDimensions(raw: unknown): LineDimensionsParse {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const value: LineDimensions = {};
  for (const [key, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDimensionKind(key)) return { ok: false };
    if (id === null) {
      value[key] = null;
      continue;
    }
    if (!isDimensionUuid(id)) return { ok: false };
    value[key] = id;
  }
  return { ok: true, value };
}

/** The non-empty ids a set of lines points at, one list per kind. */
export function dimensionIdsByKind(
  lines: ReadonlyArray<{ dimensions?: LineDimensions | null }>,
): Record<DimensionKind, string[]> {
  const out: Record<DimensionKind, Set<string>> = {
    cost_center: new Set(),
    profit_center: new Set(),
    department: new Set(),
    detail: new Set(),
  };
  for (const line of lines) {
    for (const kind of DIMENSION_KINDS) {
      const id = line.dimensions?.[kind];
      if (id) out[kind].add(id);
    }
  }
  return {
    cost_center: [...out.cost_center],
    profit_center: [...out.profit_center],
    department: [...out.department],
    detail: [...out.detail],
  };
}

// ---------------------------------------------------------------------------
// Posting policy
// ---------------------------------------------------------------------------

/** What the service knows about one value it is about to post to. */
export interface DimensionValueFacts {
  id: string;
  kind: DimensionKind;
  isActive: boolean;
  /** `null` = usable at every branch. */
  locationId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** True when the value has ANY child, active or archived: a parent is never a posting target. */
  hasChildren: boolean;
}

export type DimensionPostingProblem =
  | "dimension_not_found"
  | "dimension_kind_mismatch"
  | "dimension_kind_disabled"
  | "dimension_inactive"
  | "dimension_not_leaf"
  | "dimension_branch_mismatch"
  | "dimension_not_effective";

export interface DimensionPostingFacts {
  /** The branch the entry posts to, or `null` for a business-wide entry. */
  entryLocationId: string | null;
  /** The entry's effective day, as `YYYY-MM-DD`. */
  entryDate: string;
  /** Kinds the business has switched on. A kind that is off refuses new postings. */
  enabledKinds: ReadonlySet<DimensionKind>;
  /** Every value the lines name, keyed by id. A missing id is a value of another business, or none. */
  values: ReadonlyMap<string, DimensionValueFacts>;
  lines: ReadonlyArray<{ dimensions?: LineDimensions | null }>;
}

export interface DimensionPostingFailure {
  problem: DimensionPostingProblem;
  kind: DimensionKind;
  valueId: string;
  /** Index into `lines`, so the screen can point at the row that needs fixing. */
  lineIndex: number;
}

/**
 * The first reason these lines may not be posted with their attribution, or
 * `null` when every attributed value is usable for this entry.
 *
 * This is the policy a *new* posting is held to. It deliberately does not run
 * for a reversal of an existing entry (the reversal mirrors what the original
 * already recorded — see ISSUE_868_PLAN.md §2), and the database still checks
 * tenancy and kind on every write regardless.
 */
export function dimensionPostingFailure(facts: DimensionPostingFacts): DimensionPostingFailure | null {
  for (let lineIndex = 0; lineIndex < facts.lines.length; lineIndex++) {
    const dimensions = facts.lines[lineIndex].dimensions;
    if (!dimensions) continue;
    for (const kind of DIMENSION_KINDS) {
      const valueId = dimensions[kind];
      if (!valueId) continue;
      const fail = (problem: DimensionPostingProblem): DimensionPostingFailure => ({ problem, kind, valueId, lineIndex });

      const value = facts.values.get(valueId);
      if (!value) return fail("dimension_not_found");
      if (value.kind !== kind) return fail("dimension_kind_mismatch");
      if (!facts.enabledKinds.has(kind)) return fail("dimension_kind_disabled");
      if (!value.isActive) return fail("dimension_inactive");
      if (value.hasChildren) return fail("dimension_not_leaf");
      if (value.locationId !== null && value.locationId !== facts.entryLocationId) {
        return fail("dimension_branch_mismatch");
      }
      if (value.effectiveFrom && facts.entryDate < value.effectiveFrom) return fail("dimension_not_effective");
      if (value.effectiveTo && facts.entryDate > value.effectiveTo) return fail("dimension_not_effective");
    }
  }
  return null;
}

/**
 * Every refusal code the dimension code paths can return, in the words the
 * screens show. One table, so a route, a screen and a test cannot disagree about
 * what `dimension_kind_disabled` means.
 */
export const DIMENSION_ERROR_MESSAGES: Record<string, string> = {
  invalid_dimension: "ابعاد حسابداری یکی از سطرها معتبر نیست.",
  unknown_dimension_kind: "نوع بُعد ناشناخته است.",
  dimension_not_found: "مرکز یا بُعد انتخاب‌شده در این کسب‌وکار پیدا نشد.",
  dimension_kind_mismatch: "این مقدار با نوع بُعدی که در آن سطر است نمی‌خواند.",
  dimension_kind_disabled: "این نوع بُعد برای کسب‌وکار فعال نیست؛ ابتدا آن را در «ابعاد حسابداری» فعال کنید.",
  dimension_inactive: "این مقدار بایگانی شده است و برای سند جدید قابل استفاده نیست.",
  dimension_not_leaf: "این مقدار سرگروه است؛ سند فقط روی مقادیر پایانی ثبت می‌شود.",
  dimension_branch_mismatch: "این مقدار فقط برای شعبهٔ دیگری در دسترس است.",
  dimension_not_effective: "این مقدار در تاریخ سند معتبر نیست.",
  dimension_code_exists: "کد دیگری با همین مقدار در این نوع بُعد وجود دارد.",
  dimension_cycle: "این والد باعث حلقه در سلسله‌مراتب می‌شود.",
  invalid_parent: "والد انتخاب‌شده معتبر نیست؛ باید از همان نوع بُعد باشد.",
  parent_inactive: "والد انتخاب‌شده بایگانی شده است.",
  invalid_location: "شعبهٔ انتخاب‌شده معتبر نیست.",
  invalid_effective_date: "تاریخ اعتبار معتبر نیست.",
  invalid_setting: "تنظیم ابعاد معتبر نیست.",
  invalid_dimension_setting: "تنظیم ابعاد معتبر نیست.",
  label_not_configurable: "فقط بُعد تحلیلی نام قابل تنظیم دارد.",
  code_required: "کد الزامی است.",
  code_too_long: `کد بیش از ${DIMENSION_CODE_MAX} نویسه است.`,
  code_invalid: "کد نباید ویرگول، گیومه یا خط جدید داشته باشد.",
  name_required: "نام الزامی است.",
  name_too_long: `نام بیش از ${DIMENSION_NAME_MAX} نویسه است.`,
  invalid_effective_dates: "تاریخ پایان باید بعد از تاریخ شروع باشد.",
  label_required: "نام بُعد تحلیلی الزامی است.",
  label_too_long: `نام بُعد تحلیلی بیش از ${DIMENSION_LABEL_MAX} نویسه است.`,
  unknown_dimension_code: "کد بُعد حسابداری در این کسب‌وکار پیدا نشد.",
  inactive_dimension_code: "کد بُعد حسابداری بایگانی شده است.",
};

export function dimensionErrorMessage(code: string): string {
  return DIMENSION_ERROR_MESSAGES[code] ?? "ثبت ابعاد حسابداری انجام نشد.";
}

// ---------------------------------------------------------------------------
// Imports: map or refuse, never invent
// ---------------------------------------------------------------------------

export type DimensionCodeResolution =
  | { status: "resolved"; valueId: string }
  | { status: "unknown" }
  | { status: "inactive"; valueId: string };

/**
 * Maps the codes an import sheet names onto values of one kind.
 *
 * An unknown code is never created and never silently dropped: the importer
 * refuses that row with `unknown_dimension_code`, so the mistake is on the
 * sheet, where it can be fixed. An archived code is refused too, with its own
 * status, because it exists but is not postable any more. Matching ignores case
 * and surrounding spaces, the way the code's uniqueness rule does.
 */
export function resolveDimensionCode(
  code: string,
  values: ReadonlyArray<{ id: string; code: string; isActive: boolean }>,
): DimensionCodeResolution {
  const wanted = normalizeDimensionCode(code).toLowerCase();
  if (!wanted) return { status: "unknown" };
  const match = values.find((value) => normalizeDimensionCode(value.code).toLowerCase() === wanted);
  if (!match) return { status: "unknown" };
  if (!match.isActive) return { status: "inactive", valueId: match.id };
  return { status: "resolved", valueId: match.id };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * A report's dimension filter: one kind, and either one value of it or the
 * lines that carry none. A filter applies to lines; it never sums two kinds.
 */
export interface DimensionFilter {
  kind: DimensionKind;
  valueId: string | typeof UNASSIGNED_DIMENSION;
}

/** Reads `?dimension=<kind>&value=<id|unassigned>` from a request. `null` means no filter. */
export function parseDimensionFilter(
  kind: unknown,
  value: unknown,
): { ok: true; filter: DimensionFilter | null } | { ok: false } {
  if (kind === undefined || kind === null || kind === "") {
    return value === undefined || value === null || value === "" ? { ok: true, filter: null } : { ok: false };
  }
  if (!isDimensionKind(kind)) return { ok: false };
  if (value === UNASSIGNED_DIMENSION) return { ok: true, filter: { kind, valueId: UNASSIGNED_DIMENSION } };
  if (!isDimensionUuid(value)) return { ok: false };
  return { ok: true, filter: { kind, valueId: value } };
}

/** The signed amount a report shows: positive on the account's own side of the ledger. */
export function naturalAmount(
  debit: bigint | number,
  credit: bigint | number,
  normalBalance: "debit" | "credit",
): bigint {
  const d = BigInt(debit);
  const c = BigInt(credit);
  return normalBalance === "debit" ? d - c : c - d;
}
