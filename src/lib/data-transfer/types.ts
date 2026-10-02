/**
 * «ورود و خروج داده» — the shapes every app registers into, and the shapes the
 * engine hands back.
 *
 * This file is pure: no database, no framework, no I/O. Everything here is a
 * type or a small rule over one, so both the server engine and the client
 * mapping screen can import it, and so the registry itself is unit-testable
 * without a fixture.
 *
 * The one idea worth stating: an ENTITY is described once — its fields, their
 * types, which are required, how they validate, what they relate to, how a
 * duplicate is recognised, and which permission reads or writes them — and
 * both directions are derived from that description. There is no separate
 * "CRM import" and "POS import"; there is one engine and a registry of
 * entities, which is what stops the fourth copy of a CSV parser from ever
 * being written.
 */

import type { Permission } from "../permissions";
import type { Industry } from "../industries";

/** Which app a registered entity belongs to. Purely a grouping for the UI. */
export const DATA_MODULES = [
  "crm",
  "pos",
  "inventory",
  "accounting",
  "website",
  "workspace",
] as const;
export type DataModuleKey = (typeof DATA_MODULES)[number];

export const DATA_MODULE_LABELS: Record<DataModuleKey, string> = {
  crm: "ارتباط با مشتری",
  pos: "فروش و صندوق",
  inventory: "انبار و موجودی",
  accounting: "حسابداری",
  website: "مدیریت وب‌سایت",
  workspace: "میز کار من",
};

/**
 * The value kinds a field can hold.
 *
 * Deliberately short. Each kind is a *parsing and rendering* decision, not a
 * database type: `money` is integer Rial in storage and the business's own
 * unit on screen, `date` is a Gregorian `date` in storage and Shamsi on every
 * surface, and `reference` is the id of another entity's row which the file
 * names by text.
 */
export const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "money",
  "integer",
  "boolean",
  "date",
  "datetime",
  "enum",
  "email",
  "phone",
  "tags",
  "reference",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** One option of an `enum` field: stored value plus the Persian label. */
export interface FieldOption {
  value: string;
  label: string;
}

/**
 * What a `reference` field points at, and what to do when the named row does
 * not exist.
 *
 * This is the relationship-import rule the brief asks for (Product→Category,
 * Invoice→Customer, Order→Product, Project→Customer), expressed once per field
 * instead of once per importer:
 *
 *  - `create` — create the missing parent and carry on. Right for a product
 *    category, which is a label the operator owns.
 *  - `skip`   — reject the row. Right for an invoice's customer: inventing a
 *    customer to hang money off is worse than refusing the row.
 *  - `warn`   — import the row with the reference left empty and say so.
 */
export type RelationMissingStrategy = "create" | "skip" | "warn";

export interface FieldRelation {
  /** The entity key the value resolves against, e.g. `pos.categories`. */
  entity: string;
  /** What the file names the parent by — usually its display name or code. */
  lookupFields: readonly string[];
  /** The default when the operator expresses no preference. */
  onMissing: RelationMissingStrategy;
  /** Persian noun for the parent, for the message «دستهٔ "نوشیدنی" یافت نشد». */
  label: string;
}

/** A field's validation rules, beyond its type. */
export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** Source form of a regular expression; compiled once by the validator. */
  pattern?: string;
  /** Persian explanation shown when `pattern` fails. */
  patternMessage?: string;
}

export interface EntityField {
  /** Stable key. Also the JSON key in an export and the mapping target. */
  key: string;
  /** Persian column header — what the operator sees in the mapper and file. */
  label: string;
  type: FieldType;
  /** A row with no value here is an error, never a warning. */
  required?: boolean;
  /** Present on `enum` fields. */
  options?: readonly FieldOption[];
  /** Present on `reference` fields. */
  relation?: FieldRelation;
  validation?: FieldValidation;
  /**
   * Header spellings an uploaded file may use for this field, beyond `key` and
   * `label`. Matching is case- and space-insensitive and digit-normalised, so
   * only genuinely different words need listing.
   */
  aliases?: readonly string[];
  /** Exported by default when the operator picks no explicit field list. */
  exportDefault?: boolean;
  /** Never importable — a computed or system column (id, created_at, totals). */
  readOnly?: boolean;
  /** One line under the field in the mapping UI. */
  hint?: string;
}

/**
 * How a row is recognised as one the business already has.
 *
 * A rule is a set of fields that must ALL match; the entity may declare
 * several, and they are tried in order. `parties` matches on phone, then on
 * email, then on national id; `items` on SKU, then on barcode.
 */
export interface DuplicateRule {
  key: string;
  label: string;
  fields: readonly string[];
}

/** What to do with a row that matched an existing record. */
export type DuplicateStrategy = "update" | "skip" | "create";

/**
 * One registered entity: everything the engine needs to move it in either
 * direction, and nothing about how it is stored.
 *
 * `read`/`write` are the actual DB adapters, supplied by the module that owns
 * the table (see `src/lib/data-transfer/entities/*`). The engine never writes
 * SQL for an entity itself — it calls the module's own service functions, so
 * an imported party goes through `createParty` and gets its field encryption,
 * blind indexes and accounting code exactly as a hand-typed one does.
 */
export interface EntityDefinition {
  /** `module.entity`, e.g. `crm.customers`. Stored on every job row. */
  key: string;
  module: DataModuleKey;
  label: string;
  description: string;
  fields: readonly EntityField[];
  duplicateRules?: readonly DuplicateRule[];
  /** The permission that may export this entity. */
  exportPermission: Permission;
  /** The permission that may import it. Absent ⇒ export-only. */
  importPermission?: Permission;
  /**
   * True when the entity's rows belong to a branch rather than the business
   * (`menu_items`, `items`, `inventory_items`). The engine then requires an
   * active location and passes it to the adapters.
   */
  locationScoped?: boolean;
  /** The industry module this entity needs; absent ⇒ every trade has it. */
  requiresModule?: string;
  /**
   * The one industry this entity belongs to; absent ⇒ every trade has it.
   *
   * Issue #799 §7 — the BOQ's measured rows are an AEC idea: a café has no
   * chapters, no measured quantities and no rate build-up, so offering it their
   * import would be a piece of another trade's vocabulary on their screen. The
   * catalogue route hides such an entity, and the adapter refuses it anyway, so
   * a hand-made request cannot write BOQ rows into a restaurant either.
   *
   * (Deliberately a separate axis from `requiresModule` above, which names a
   * module key within a trade and is — as of this wave — still unread: wiring
   * that one up changes which entities three existing POS imports offer, which
   * is the cleanup wave's decision, not this one's.)
   */
  requiresIndustry?: Industry;
}

/** A parsed file, before any mapping has been applied. */
export interface ParsedSheet {
  /** The header row, trimmed. */
  columns: string[];
  /** Body rows. Short rows are padded to the header's width by the parser. */
  rows: string[][];
}

/** One external column → one platform field, plus an optional transformation. */
export interface ColumnMapping {
  /** The platform field's key. */
  field: string;
  /**
   * The source column's index in `ParsedSheet.columns`. `-1` means "not from
   * the file": the value comes from `constant` instead.
   */
  column: number;
  /** Used when `column` is -1 — a fixed value applied to every row. */
  constant?: string;
  /** Applied to the cell text before the field's own coercion. */
  transform?: TransformRule;
}

/**
 * The transformations a mapping may apply. Deliberately a closed list rather
 * than an expression language: a saved template is executed later, by a
 * background worker, against a tenant's data — an eval-shaped feature there
 * would be a remote code execution hole wearing a spreadsheet costume.
 */
export const TRANSFORM_RULES = [
  "none",
  "trim",
  "upper",
  "lower",
  "digits",
  "persian_digits",
  "strip_spaces",
  "toman_to_rial",
  "rial_to_toman",
  "percent_to_fraction",
  "boolean_yes_no",
] as const;
export type TransformRule = (typeof TRANSFORM_RULES)[number];

export const TRANSFORM_LABELS: Record<TransformRule, string> = {
  none: "بدون تغییر",
  trim: "حذف فاصله‌های ابتدا و انتها",
  upper: "حروف بزرگ",
  lower: "حروف کوچک",
  digits: "تبدیل ارقام فارسی به انگلیسی",
  persian_digits: "تبدیل ارقام انگلیسی به فارسی",
  strip_spaces: "حذف همهٔ فاصله‌ها",
  toman_to_rial: "تبدیل تومان به ریال",
  rial_to_toman: "تبدیل ریال به تومان",
  percent_to_fraction: "تبدیل درصد به نسبت",
  boolean_yes_no: "تبدیل بله/خیر به درست/نادرست",
};

/** The full mapping of one file: the field list plus how each is filled. */
export interface ImportMapping {
  columns: ColumnMapping[];
}

/** Everything the operator chose about how the import should behave. */
export interface ImportOptions {
  /** Which duplicate rule to apply; absent ⇒ the entity's first rule. */
  duplicateRule?: string;
  duplicateStrategy?: DuplicateStrategy;
  /** Per-reference-field override of the entity's default. */
  relationStrategy?: Record<string, RelationMissingStrategy>;
  /** Import the rows that passed and report the rest, instead of refusing all. */
  validOnly?: boolean;
  /** How money columns in the file are denominated. Defaults to the business's unit. */
  moneyUnit?: "toman" | "rial";
}

/** Severity of one message about one row. */
export type RowSeverity = "error" | "warning";

export interface RowMessage {
  field: string | null;
  severity: RowSeverity;
  message: string;
}

/** A row after mapping, coercion and validation — before anything is written. */
export interface ValidatedRow {
  rowNumber: number;
  raw: Record<string, string>;
  values: Record<string, unknown>;
  messages: RowMessage[];
  /** No error messages. A row may be valid and still carry warnings. */
  valid: boolean;
}

/** The preview the operator approves. */
export interface ImportPreview {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  /** Capped for transport; the full set lives in `data_import_rows`. */
  rows: ValidatedRow[];
  /** Source columns that no field claimed, so the operator can see the gap. */
  unmappedColumns: string[];
  /** Required fields with no mapping — the import cannot proceed. */
  missingRequired: string[];
}

/** One export column, resolved from a field. */
export interface ExportColumn {
  key: string;
  label: string;
  type: FieldType;
}

export type ExportFormat = "csv" | "xlsx" | "pdf" | "json";

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
  pdf: "PDF",
  json: "JSON",
};

export type ImportFormat = "csv" | "xlsx" | "json" | "pdf";

export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  csv: "CSV",
  xlsx: "Excel",
  json: "JSON",
  pdf: "PDF",
};

export type ImportJobStatus =
  | "pending"
  | "ready"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ExportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const IMPORT_STATUS_LABELS: Record<ImportJobStatus, string> = {
  pending: "در انتظار نگاشت",
  ready: "آمادهٔ اجرا",
  queued: "در صف",
  running: "در حال اجرا",
  completed: "انجام شد",
  failed: "ناموفق",
  cancelled: "لغو شد",
};

export const EXPORT_STATUS_LABELS: Record<ExportJobStatus, string> = {
  queued: "در صف",
  running: "در حال ساخت",
  completed: "آماده",
  failed: "ناموفق",
  cancelled: "لغو شد",
};

export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  daily: "روزانه",
  weekly: "هفتگی",
  monthly: "ماهانه",
};

/** Persian weekday names, Saturday first — the Persian week. */
export const WEEKDAY_LABELS = [
  "شنبه",
  "یک‌شنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنج‌شنبه",
  "جمعه",
] as const;
