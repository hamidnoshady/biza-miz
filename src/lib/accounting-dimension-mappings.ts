/**
 * «انتساب ابعاد در اسناد عملیاتی» — the deterministic attribution policy for
 * operational postings (issue #868, Phase 3).
 *
 * A purchase, a sale or a cost-of-goods-sold posting is one aggregate journal
 * entry built by the posting engine, not a document a person dims line by
 * line. When a business wants those postings attributed, it writes **mapping
 * rules**: one source reference (an item, a product category, a supplier, a
 * sales channel) → one dimension tuple. This module is the pure decision of
 * which rule wins — framework-free, so the policy is unit-tested with plain
 * fixtures (`accounting-dimension-mappings.test.ts`).
 *
 * ## Precedence (documented, deterministic, never inferred)
 *
 *   1. **Explicit attribution** the posting caller carries (a mirror, an
 *      amendment, a source document that already has attribution). The caller
 *      applies this before consulting mappings; this module never overrides it.
 *   2. **Mapping rules**, most specific scope first, resolved **per kind**:
 *
 *        item → product_category → supplier → sales_channel
 *
 *      At each scope level, the kind is adopted only when every matching rule
 *      that speaks on it agrees (same value). A rule silent on the kind
 *      abstains. Rules that disagree make the level unusable for that kind and
 *      resolution falls through to the next level — a disagreement is never
 *      settled by guessing, and a level that says nothing about a kind does
 *      not veto the next one.
 *   3. **Unassigned.** No reliable rule means the posting goes out exactly as
 *      it did before this feature existed.
 *
 * A rule only matches when it is active and its effective window covers the
 * posting date. And a rule whose value would not pass the posting policy for
 * this entry (archived, switched-off kind, wrong branch, parent value, out of
 * window) is **skipped as if absent**: a stale rule must never block a sale.
 * The caller filters postability (`filterPostable`) with the same policy the
 * manual-journal path uses, then calls `resolveTradingDimensions`.
 *
 * History is stable: the resolved tuple is stamped on the journal lines at
 * posting time and never re-read, so editing or archiving a rule tomorrow
 * cannot change a document posted today.
 */
import {
  DIMENSION_KINDS,
  isDimensionUuid,
  normalizeDimensionCode,
  type DimensionKind,
  type LineDimensions,
} from "./accounting-dimensions";
import { normalizeOptionalIsoDate } from "./iso-date";

/** The sources a rule can be keyed by, most specific first. */
export const MAPPING_SCOPES = ["item", "product_category", "supplier", "sales_channel"] as const;
export type MappingScope = (typeof MAPPING_SCOPES)[number];

/** Persian names for the management screen. */
export const MAPPING_SCOPE_LABELS: Record<MappingScope, string> = {
  item: "کالا",
  product_category: "دسته‌بندی کالا",
  supplier: "تأمین‌کننده",
  sales_channel: "کانال فروش",
};

/**
 * What each scope is for, shown under it on the mapping screen. The last
 * sentence is the one that matters to an accountant: a rule assigns, it never
 * invents.
 */
export const MAPPING_SCOPE_DESCRIPTIONS: Record<MappingScope, string> = {
  item: "سندی که این کالا را دارد را انتساب می‌دهد؛ دقیق‌ترین قانون.",
  product_category: "اسناد همهٔ کالاهای این دسته را انتساب می‌دهد، وقتی قانون کالای تکی ندارید.",
  supplier: "خریدها و برگشت‌های این تأمین‌کننده را انتساب می‌دهد.",
  sales_channel: "فروش این کانال (حضوری، بیرون‌بر، ارسال، پلتفرم آنلاین) را انتساب می‌دهد.",
};

/** The stable keys the posting engine derives for channel-scope rules. */
export const SALES_CHANNEL_ORDER = ["dine_in", "takeaway", "delivery"] as const;
export type OrderSalesChannel = (typeof SALES_CHANNEL_ORDER)[number];

export function isMappingScope(value: unknown): value is MappingScope {
  return typeof value === "string" && (MAPPING_SCOPES as readonly string[]).includes(value);
}

/** The platform key a settlement method maps to, e.g. `platform:snappfood`. */
export function platformChannelRef(settlement: string): string {
  return `platform:${normalizeDimensionCode(settlement).toLowerCase()}`;
}

/** The channel key an order channel maps to, e.g. `channel:dine_in`. */
export function orderChannelRef(channel: string): string {
  return `channel:${normalizeDimensionCode(channel).toLowerCase()}`;
}

export type MappingRefProblem = "mapping_ref_required" | "mapping_ref_too_long" | "mapping_ref_invalid";

export const MAPPING_REF_MAX = 64;

/**
 * A ref is a uuid for the entity scopes and a stable key for the channel
 * scope. Whatever the scope, it may not hold a comma, quote or newline —
 * the same rule dimension codes follow, because refs appear in exports.
 */
export function mappingRefProblem(scope: MappingScope, ref: string): MappingRefProblem | null {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return "mapping_ref_required";
  if (trimmed.length > MAPPING_REF_MAX) return "mapping_ref_too_long";
  if (/[,\"\n\r]/.test(trimmed)) return "mapping_ref_invalid";
  if (scope !== "sales_channel" && !isDimensionUuid(trimmed)) return "mapping_ref_invalid";
  return null;
}

// ---------------------------------------------------------------------------
// The rule and the document
// ---------------------------------------------------------------------------

/** One mapping rule as the resolver reads it. */
export interface DimensionMappingRule {
  scope: MappingScope;
  /** The source reference: an item/category/supplier id, or a channel key. */
  ref: string;
  dimensions: LineDimensions;
  isActive: boolean;
  /** `YYYY-MM-DD` or null. */
  effectiveFrom: string | null;
  /** `YYYY-MM-DD` or null. */
  effectiveTo: string | null;
}

/**
 * The document's source references. Sets, not single values: an order can
 * carry several items and categories, and a rule at a level only applies when
 * every matching rule at that level agrees.
 */
export interface TradingDocumentRefs {
  /** Inventory/menu item ids on the document. */
  itemRefs?: readonly string[];
  /** Product category ids of those items. */
  categoryRefs?: readonly string[];
  /** The supplier, for purchases and supplier returns. */
  supplierRef?: string | null;
  /**
   * Channel keys, most specific first — e.g. `platform:snappfood` then
   * `channel:delivery`. The resolver consults them in order.
   */
  channelRefs?: readonly string[];
}

export interface ResolveTradingOptions {
  /** The posting day, `YYYY-MM-DD`: a rule's window must cover it. */
  entryDate: string;
  /** Kinds the business has switched on. A disabled kind is never assigned. */
  enabledKinds: ReadonlySet<DimensionKind>;
}

function ruleMatches(rule: DimensionMappingRule, options: ResolveTradingOptions): boolean {
  if (!rule.isActive) return false;
  const day = options.entryDate;
  if (rule.effectiveFrom && day < rule.effectiveFrom) return false;
  if (rule.effectiveTo && day > rule.effectiveTo) return false;
  return true;
}

/** The rules that match this document at one scope level, in document order. */
function matchesAtScope(
  rules: readonly DimensionMappingRule[],
  scope: MappingScope,
  refs: TradingDocumentRefs,
  options: ResolveTradingOptions,
): DimensionMappingRule[] {
  if (scope === "item") {
    const wanted = new Set((refs.itemRefs ?? []).map((r) => r.trim().toLowerCase()));
    if (wanted.size === 0) return [];
    return rules.filter((r) => r.scope === scope && wanted.has(r.ref.trim().toLowerCase()) && ruleMatches(r, options));
  }
  if (scope === "product_category") {
    const wanted = new Set((refs.categoryRefs ?? []).map((r) => r.trim().toLowerCase()));
    if (wanted.size === 0) return [];
    return rules.filter((r) => r.scope === scope && wanted.has(r.ref.trim().toLowerCase()) && ruleMatches(r, options));
  }
  if (scope === "supplier") {
    const ref = refs.supplierRef?.trim().toLowerCase();
    if (!ref) return [];
    return rules.filter((r) => r.scope === scope && r.ref.trim().toLowerCase() === ref && ruleMatches(r, options));
  }
  // sales_channel: the document's channel refs are ordered by specificity;
  // the first channel key with a matching rule is the level's match set.
  for (const channelRef of refs.channelRefs ?? []) {
    const wanted = channelRef.trim().toLowerCase();
    if (!wanted) continue;
    const found = rules.filter((r) => r.scope === scope && r.ref.trim().toLowerCase() === wanted && ruleMatches(r, options));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Resolves the attribution an operational posting should carry from its
 * document's references and the business's rules, **per kind**.
 *
 * At each scope level the kind is adopted only when every matching rule that
 * speaks on it agrees; silence abstains and disagreement falls through to the
 * next level. Nothing reliable leaves the kind absent («بدون بُعد»). The
 * result is `null` when no kind resolved — the caller then posts without
 * attribution, exactly as before this feature.
 */
export function resolveTradingDimensions(
  rules: readonly DimensionMappingRule[],
  refs: TradingDocumentRefs,
  options: ResolveTradingOptions,
): LineDimensions | null {
  const resolved: LineDimensions = {};
  let any = false;
  for (const kind of DIMENSION_KINDS) {
    if (!options.enabledKinds.has(kind)) continue;
    for (const scope of MAPPING_SCOPES) {
      const matches = matchesAtScope(rules, scope, refs, options);
      if (matches.length === 0) continue;
      const speaking = matches.map((m) => m.dimensions[kind]).filter((v): v is string => Boolean(v));
      if (speaking.length === 0) continue; // the level abstains on this kind
      const distinct = new Set(speaking);
      if (distinct.size === 1) {
        resolved[kind] = speaking[0];
        any = true;
        break;
      }
      // Conflict at this level: unusable for this kind, try the next level.
    }
  }
  return any ? resolved : null;
}

/**
 * Drops every value that would not pass the posting policy for this entry
 * (unknown, wrong kind, disabled kind, archived, parent, wrong branch, out of
 * window) — so a stale rule degrades to the next rule or to unassigned and
 * never blocks the document. `postable` is asked with the same policy the
 * manual-journal path enforces.
 */
export function filterPostable(
  dimensions: LineDimensions | null | undefined,
  postable: (kind: DimensionKind, valueId: string) => boolean,
): LineDimensions | null {
  if (!dimensions) return null;
  const kept: LineDimensions = {};
  let any = false;
  for (const kind of DIMENSION_KINDS) {
    const valueId = dimensions[kind];
    if (!valueId) continue;
    if (postable(kind, valueId)) {
      kept[kind] = valueId;
      any = true;
    }
  }
  return any ? kept : null;
}

/**
 * Per-kind merge used when a caller already carries explicit attribution and
 * mapping rules fill the rest: the explicit value always wins, and a kind the
 * explicit attribution deliberately leaves empty is filled from the mapping —
 * never the other way round.
 */
export function mergeExplicitDimensions(
  explicit: LineDimensions | null | undefined,
  mapped: LineDimensions | null,
): LineDimensions | null {
  const merged: LineDimensions = { ...(mapped ?? {}) };
  let any = false;
  for (const kind of DIMENSION_KINDS) {
    const valueId = explicit?.[kind];
    if (valueId) {
      merged[kind] = valueId;
      any = true;
    } else if (merged[kind]) {
      any = true;
    }
  }
  return any ? merged : null;
}

/** Reads the date rules are matched against; `null` means «no window to check». */
export function normalizeMappingDate(value: unknown): { ok: true; value: string | null } | { ok: false } {
  return normalizeOptionalIsoDate(value);
}
