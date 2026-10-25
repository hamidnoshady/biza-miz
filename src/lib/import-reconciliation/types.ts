/**
 * Universal safe import & first-sync reconciliation (issue #1118) — the shared
 * vocabulary.
 *
 * This file is pure: no database, no framework, no I/O, so the server engine,
 * the review screens and the unit tests all read the same words. It deliberately
 * names nothing provider-specific. Holoo, WooCommerce, a CSV upload and a future
 * ERP all describe what they bring as `IncomingRecord`s of one of the
 * `ReconciliationDomain`s, and the engine answers each with one
 * `ReconciliationOutcome` before any canonical row is written.
 */

/** The kinds of data the engine knows how to match. Each has its own resolver. */
export const RECONCILIATION_DOMAINS = ["product", "party", "financial_document", "inventory"] as const;
export type ReconciliationDomain = (typeof RECONCILIATION_DOMAINS)[number];

export const RECONCILIATION_DOMAIN_LABELS: Record<ReconciliationDomain, string> = {
  product: "کالا و محصول",
  party: "طرف‌حساب",
  financial_document: "سند مالی و سفارش",
  inventory: "موجودی انبار",
};

/** What kind of thing the data came from. Not a provider list: a provider is `provider`. */
export const RECONCILIATION_SOURCE_KINDS = ["file", "provider", "plugin", "api", "database", "scheduled"] as const;
export type ReconciliationSourceKind = (typeof RECONCILIATION_SOURCE_KINDS)[number];

/**
 * How the source relates to the business afterwards. A one-time file import is
 * NOT a live two-way connection; the mode is recorded so nothing downstream
 * assumes pull/push/webhook support the source never promised.
 */
export const RECONCILIATION_IMPORT_MODES = ["preview_only", "one_time", "backfill", "live_link"] as const;
export type ReconciliationImportMode = (typeof RECONCILIATION_IMPORT_MODES)[number];

export const RECONCILIATION_IMPORT_MODE_LABELS: Record<ReconciliationImportMode, string> = {
  preview_only: "فقط پیش‌نمایش",
  one_time: "ورود یک‌باره",
  backfill: "ورود تاریخچه",
  live_link: "اتصال زنده",
};

/**
 * The verdict on one incoming record. The set is closed on purpose: a screen,
 * a report and a test all switch on the same nine words.
 *
 *  - `already_linked`   a verified source identity already points at a canonical row.
 *  - `safe_match`       exactly one candidate on an unambiguous, domain-approved identity.
 *  - `create_new`       nothing overlaps; a canonical row would be created.
 *  - `field_conflict`   linked (or matched) but a protected field disagrees.
 *  - `ambiguous`        more than one reading — a person decides, nothing is guessed.
 *  - `invalid`          unusable data (no identity, bad amount, bad unit).
 *  - `historical_match` a past transaction that already exists in the books.
 *  - `skipped`          deliberately not imported (decided, or out of scope).
 *  - `failed`           the apply step failed for this record.
 */
export const RECONCILIATION_OUTCOMES = [
  "already_linked",
  "safe_match",
  "create_new",
  "field_conflict",
  "ambiguous",
  "invalid",
  "historical_match",
  "skipped",
  "failed",
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

export const RECONCILIATION_OUTCOME_LABELS: Record<ReconciliationOutcome, string> = {
  already_linked: "پیوند تأییدشده",
  safe_match: "تطبیق امن",
  create_new: "مورد جدید",
  field_conflict: "ناسازگاری فیلد",
  ambiguous: "نیازمند بررسی",
  invalid: "نامعتبر",
  historical_match: "تطبیق با سابقه",
  skipped: "نادیده گرفته شد",
  failed: "ناموفق",
};

/** Outcomes that never need a person: nothing overlaps, or the link is already verified. */
export const SAFE_OUTCOMES: readonly ReconciliationOutcome[] = ["already_linked", "safe_match", "create_new"];

/** Outcomes where a person has to choose before anything is written. */
export const REVIEW_OUTCOMES: readonly ReconciliationOutcome[] = ["field_conflict", "ambiguous"];

/** What an owner (or authorised operator) can decide about one record. */
export const RECONCILIATION_DECISIONS = [
  "link",
  "create_separate",
  "skip",
  "choose_authority",
  "keep_for_review",
] as const;
export type ReconciliationDecision = (typeof RECONCILIATION_DECISIONS)[number];

export const RECONCILIATION_DECISION_LABELS: Record<ReconciliationDecision, string> = {
  link: "پیوند به مورد موجود",
  create_separate: "ایجاد جداگانه",
  skip: "نادیده گرفتن",
  choose_authority: "انتخاب مرجع فیلد",
  keep_for_review: "نگه‌داشتن برای بررسی",
};

/** What applying an approved item actually does. Derived from outcome + decision. */
export type ReconciliationEffect = "none" | "link" | "create" | "skip";

/** Run lifecycle — see `lifecycle.ts` for the allowed moves. */
export const RECONCILIATION_RUN_STATUSES = [
  "discovering",
  "staged",
  "in_review",
  "applying",
  "applied",
  "partially_applied",
  "failed",
  "cancelled",
  "stale",
] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const RECONCILIATION_RUN_STATUS_LABELS: Record<ReconciliationRunStatus, string> = {
  discovering: "در حال خواندن",
  staged: "آمادهٔ بررسی",
  in_review: "در حال بررسی",
  applying: "در حال اعمال",
  applied: "اعمال شد",
  partially_applied: "اعمال ناقص",
  failed: "ناموفق",
  cancelled: "لغو شد",
  stale: "پیش‌نمایش منسوخ",
};

/** A run in one of these states owns its scope: no second run may start on it. */
export const ACTIVE_RUN_STATUSES: readonly ReconciliationRunStatus[] = [
  "discovering",
  "staged",
  "in_review",
  "applying",
  "stale",
];

export const RECONCILIATION_ITEM_STATUSES = [
  "proposed",
  "approved",
  "held",
  "skipped",
  "applied",
  "failed",
] as const;
export type ReconciliationItemStatus = (typeof RECONCILIATION_ITEM_STATUSES)[number];

/** Money and quantities cross the engine as strings: floats never touch them. */
export type DecimalString = string;

export type ProductKind = "simple" | "variant_parent" | "variant_child";
export type ProductTracking = "none" | "serial" | "weight" | "lot";

// ---------------------------------------------------------------------------
// Incoming records — what a source brings
// ---------------------------------------------------------------------------

interface IncomingBase {
  /** The source's own id for the record. Null only for a file row with no id column. */
  externalId: string | null;
  /** 1-based row for file sources, so a report can point at the line. */
  rowNumber?: number;
}

export interface IncomingProduct extends IncomingBase {
  domain: "product";
  name: string | null;
  sku?: string | null;
  barcodes?: readonly string[];
  kind?: ProductKind;
  /** The source's id of the parent when `kind` is a variant child. */
  parentExternalId?: string | null;
  unit?: string | null;
  tracking?: ProductTracking | null;
  variantOptions?: Readonly<Record<string, string>>;
  /** Every other comparable field, keyed by the platform field name. */
  fields?: Readonly<Record<string, unknown>>;
}

export type PartyRole = "customer" | "supplier" | "employee";

export interface IncomingParty extends IncomingBase {
  domain: "party";
  name: string | null;
  phone?: string | null;
  email?: string | null;
  role?: PartyRole | null;
  /**
   * What the source says about marketing consent. It is recorded as evidence and
   * NEVER transferred: a spreadsheet or another system is not the person's consent.
   */
  consent?: Readonly<Record<string, boolean>>;
  fields?: Readonly<Record<string, unknown>>;
}

export type FinancialDocumentKind = "invoice" | "order" | "payment" | "refund" | "journal";
export type FinancialDocumentStatus = "paid" | "pending" | "unpaid" | "refunded" | "cancelled";

export interface IncomingFinancialDocument extends IncomingBase {
  domain: "financial_document";
  kind: FinancialDocumentKind;
  status?: FinancialDocumentStatus;
  /** Integer Rial, as a string. The adapter converts Toman before the engine sees it. */
  totalRial: DecimalString | null;
  currency?: string | null;
  /** Gregorian ISO date; Shamsi is a display concern. */
  date?: string | null;
  /** Trusted secondary references (order number, invoice number, payment reference). */
  references?: readonly string[];
  lines?: readonly { sku: string | null; quantity: DecimalString; amountRial: DecimalString }[];
  fields?: Readonly<Record<string, unknown>>;
}

export type InventoryRecordKind = "snapshot" | "movement";

export interface IncomingInventory extends IncomingBase {
  domain: "inventory";
  kind: InventoryRecordKind;
  /** The source id of the product this quantity belongs to. */
  productExternalId: string | null;
  locationKey?: string | null;
  /** Null means the source does not manage stock for it — never "zero". */
  quantity: DecimalString | null;
  lot?: string | null;
  serial?: string | null;
  /** What caused a movement. `online_order` is owned by the order, not by an adjustment. */
  cause?: "adjustment" | "purchase" | "sale" | "online_order" | "transfer" | "opening";
  fields?: Readonly<Record<string, unknown>>;
}

export type IncomingRecord =
  | IncomingProduct
  | IncomingParty
  | IncomingFinancialDocument
  | IncomingInventory;

// ---------------------------------------------------------------------------
// Resolution — what the engine says about one record
// ---------------------------------------------------------------------------

/** Machine-readable reasons; `RESOLUTION_REASON_LABELS` turns them into Persian. */
export const RESOLUTION_REASONS = [
  "verified_mapping",
  "mapped_target_missing",
  "unique_barcode",
  "unique_sku",
  "no_overlap",
  "missing_identity",
  "duplicate_in_source",
  "identifier_collision",
  "identifier_conflict",
  "multiple_candidates",
  "name_only",
  "type_mismatch",
  "unit_mismatch",
  "tracking_mismatch",
  "variant_mismatch",
  "branch_mismatch",
  "phone_match_unverified",
  "email_match_unverified",
  "verified_phone",
  "role_mismatch",
  "guest_or_archived",
  "reference_match",
  "reference_total_mismatch",
  "amount_date_only",
  "invalid_amount",
  "currency_mismatch",
  "historical_unmatched",
  "product_unresolved",
  "null_quantity",
  "stock_unmanaged",
  "stock_equal",
  "stock_differs",
  "opening_stock",
  "duplicate_snapshot",
  "movement_already_applied",
  "order_owned_stock",
  "serial_quantity",
] as const;
export type ResolutionReason = (typeof RESOLUTION_REASONS)[number];

export const RESOLUTION_REASON_LABELS: Record<ResolutionReason, string> = {
  verified_mapping: "پیوند تأییدشدهٔ قبلی",
  mapped_target_missing: "مقصد پیوند قبلی دیگر وجود ندارد",
  unique_barcode: "بارکد یکتا",
  unique_sku: "کد کالا یکتا",
  no_overlap: "هیچ هم‌پوشانی‌ای یافت نشد",
  missing_identity: "هیچ شناسه‌ای برای تطبیق وجود ندارد",
  duplicate_in_source: "تکرار در خود منبع",
  identifier_collision: "شناسه‌ها به چند مورد اشاره می‌کنند",
  identifier_conflict: "شناسه‌های مورد موجود با منبع نمی‌خواند",
  multiple_candidates: "چند مورد موجود هم‌خوان است",
  name_only: "فقط نام یکسان است",
  type_mismatch: "نوع (والد/زیرمجموعه) یکسان نیست",
  unit_mismatch: "واحد یکسان نیست",
  tracking_mismatch: "روش ردیابی (سریال/لات) یکسان نیست",
  variant_mismatch: "ویژگی‌های تنوع یکسان نیست",
  branch_mismatch: "شعبه یکسان نیست",
  phone_match_unverified: "شمارهٔ یکسان اما تأییدنشده",
  email_match_unverified: "ایمیل یکسان اما تأییدنشده",
  verified_phone: "شمارهٔ تأییدشدهٔ یکتا",
  role_mismatch: "نقش (مشتری/تأمین‌کننده) یکسان نیست",
  guest_or_archived: "مهمان یا بایگانی‌شده",
  reference_match: "شمارهٔ مرجع یکسان",
  reference_total_mismatch: "مرجع یکسان اما مبلغ یا ارز متفاوت است",
  amount_date_only: "فقط مبلغ و تاریخ یکسان است",
  invalid_amount: "مبلغ نامعتبر",
  currency_mismatch: "ارز یکسان نیست",
  historical_unmatched: "سابقهٔ بدون تطبیق",
  product_unresolved: "کالای این موجودی هنوز تعیین تکلیف نشده",
  null_quantity: "مقدار خالی است، نه صفر",
  stock_unmanaged: "موجودی این کالا مدیریت نمی‌شود",
  stock_equal: "موجودی یکسان است",
  stock_differs: "موجودی متفاوت است",
  opening_stock: "موجودی اول دوره",
  duplicate_snapshot: "دو شمارش موجودی برای یک کالا",
  movement_already_applied: "این حرکت قبلاً اعمال شده",
  order_owned_stock: "کسر موجودی بر عهدهٔ سفارش آنلاین است",
  serial_quantity: "کالای سریال‌دار باید مقدار یک داشته باشد",
};

export type FieldAuthorityAction =
  | "keep_canonical"
  | "fill_blank"
  | "keep_source_local"
  | "take_source"
  | "review";

export interface FieldConflict {
  field: string;
  fieldClass: FieldClass;
  canonical: unknown;
  incoming: unknown;
  action: FieldAuthorityAction;
  /** True when a person must choose; false when the policy settles it. */
  needsReview: boolean;
}

/** Why a field is governed the way it is. */
export const FIELD_CLASSES = ["financial", "stock", "identity", "presentation", "store_price"] as const;
export type FieldClass = (typeof FIELD_CLASSES)[number];

export interface MatchEvidence {
  /** What matched: `sku`, `barcode`, `phone`, `email`, `reference`, `mapping`, `name`, `amount_date`. */
  kind: string;
  value: string;
  /** Weak evidence (name, amount+date) is shown but never linked on its own. */
  weak: boolean;
}

export interface CandidateRef {
  id: string;
  label: string;
}

export interface Resolution {
  outcome: ReconciliationOutcome;
  reasons: ResolutionReason[];
  /** The canonical row the record is linked/matched to, when there is exactly one. */
  canonicalId: string | null;
  /** Every candidate the person may choose between. */
  candidates: CandidateRef[];
  evidence: MatchEvidence[];
  /** True for a past transaction: matched/reconciled, never auto-posted. */
  historical: boolean;
  /** Free-form notes the review screen shows verbatim (already Persian-safe codes). */
  notes: string[];
}

export function emptyResolution(outcome: ReconciliationOutcome, reasons: ResolutionReason[]): Resolution {
  return { outcome, reasons, canonicalId: null, candidates: [], evidence: [], historical: false, notes: [] };
}

/** Who may do what to an item, given its outcome — used by the service and the screens. */
export function allowedDecisions(outcome: ReconciliationOutcome, hasCandidates: boolean): ReconciliationDecision[] {
  switch (outcome) {
    case "already_linked":
    case "historical_match":
      return ["keep_for_review", "skip"];
    case "safe_match":
      return ["link", "create_separate", "skip", "keep_for_review"];
    case "create_new":
      return ["create_separate", "skip", "keep_for_review"];
    case "field_conflict":
      return ["choose_authority", "skip", "keep_for_review"];
    case "ambiguous":
      return hasCandidates
        ? ["link", "create_separate", "skip", "keep_for_review"]
        : ["create_separate", "skip", "keep_for_review"];
    case "invalid":
    case "failed":
      return ["skip", "keep_for_review"];
    case "skipped":
      return ["keep_for_review"];
  }
}
