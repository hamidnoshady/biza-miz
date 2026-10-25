/**
 * Field authority — pure.
 *
 * Which system owns which field is explicit, per domain, and an import never
 * decides it by arrival time. The rules are the issue's: accounting cost and
 * official stock belong to the books; a website's presentation and per-store
 * price belong to that website; there is no global last-write-wins for a
 * financial or stock field.
 *
 *   field class     default owner           what an incoming value does
 *   ─────────────   ─────────────────────   ──────────────────────────────────
 *   financial       canonical books         recorded as a conflict, never applied
 *   stock           canonical books         recorded as a conflict, never applied
 *   identity        canonical               fills a blank; a difference is reviewed
 *   presentation    the source, locally     kept on the source's own snapshot
 *   store_price     the source, per store   kept per mapping, never canonical
 *
 * An owner can override a class for one record through a `choose_authority`
 * decision, except that the protected classes (financial, stock) require the
 * override to be explicit and are always audited — the policy function only
 * answers what is allowed, the service records who allowed it.
 */

import type { FieldAuthorityAction, FieldClass, FieldConflict, ReconciliationDomain } from "./types";

export type FieldOwner = "canonical" | "source";

/** Fields whose class is not "presentation", by domain. Anything unlisted is presentation. */
const FIELD_CLASS_BY_DOMAIN: Record<ReconciliationDomain, Readonly<Record<string, FieldClass>>> = {
  product: {
    // Accounting-owned.
    cost: "financial",
    average_cost: "financial",
    price: "financial",
    tax_rate: "financial",
    tax_class: "financial",
    // Official stock.
    stock_quantity: "stock",
    low_stock_threshold: "stock",
    // Who the product is.
    sku: "identity",
    barcode: "identity",
    unit: "identity",
    tracking: "identity",
    kind: "identity",
    // A website's own selling price for this store.
    store_price: "store_price",
    sale_price: "store_price",
    regular_price: "store_price",
  },
  party: {
    national_id: "identity",
    economic_code: "identity",
    phone: "identity",
    email: "identity",
    opening_balance: "financial",
    credit_limit: "financial",
  },
  financial_document: {
    total_rial: "financial",
    tax_rial: "financial",
    discount_rial: "financial",
    status: "financial",
    paid_rial: "financial",
  },
  inventory: {
    quantity: "stock",
    stock_quantity: "stock",
    lot: "stock",
    serial: "stock",
  },
};

export function fieldClassFor(domain: ReconciliationDomain, field: string): FieldClass {
  return FIELD_CLASS_BY_DOMAIN[domain][field] ?? "presentation";
}

/** Financial and stock fields can never be overwritten by an import without an explicit, audited override. */
export function isProtectedClass(fieldClass: FieldClass): boolean {
  return fieldClass === "financial" || fieldClass === "stock";
}

/**
 * The per-connection/provider policy. Absent entries fall back to the defaults
 * above. `source` ownership is only honoured for the classes where a source may
 * legitimately own something (presentation, store_price) — a policy that tries
 * to hand a source financial or stock authority is ignored, which is the
 * "no global last-write-wins" rule enforced where it cannot be configured away.
 */
export interface FieldAuthorityPolicy {
  /** Bumped when the policy changes, so a preview built under the old one goes stale. */
  version: number;
  /** `fieldClass` → owner, for this provider/connection. */
  classOwners?: Partial<Record<FieldClass, FieldOwner>>;
  /** `field` → owner, for one named field. */
  fieldOwners?: Readonly<Record<string, FieldOwner>>;
}

export const DEFAULT_FIELD_AUTHORITY_POLICY: FieldAuthorityPolicy = { version: 1 };

/** Per-record overrides recorded on a `choose_authority` decision. */
export type FieldAuthorityOverrides = Readonly<Record<string, FieldOwner>>;

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (typeof a === "number" || typeof b === "number" || typeof a === "bigint" || typeof b === "bigint") {
    return String(a) === String(b);
  }
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return JSON.stringify(a) === JSON.stringify(b);
}

export function resolveFieldOwner(
  policy: FieldAuthorityPolicy,
  domain: ReconciliationDomain,
  field: string,
  overrides?: FieldAuthorityOverrides,
): FieldOwner {
  const fieldClass = fieldClassFor(domain, field);
  const override = overrides?.[field];
  if (override) return override;
  const configured = policy.fieldOwners?.[field] ?? policy.classOwners?.[fieldClass];
  if (configured === "source" && !isProtectedClass(fieldClass) && fieldClass !== "identity") return "source";
  return "canonical";
}

/**
 * What to do with one field whose incoming value differs from the canonical
 * one. Never returns `take_source` for a protected class unless the person
 * overrode it for this record.
 */
export function resolveFieldAction(
  policy: FieldAuthorityPolicy,
  domain: ReconciliationDomain,
  field: string,
  canonical: unknown,
  incoming: unknown,
  overrides?: FieldAuthorityOverrides,
): FieldAuthorityAction {
  const fieldClass = fieldClassFor(domain, field);
  if (sameValue(canonical, incoming)) return "keep_canonical";
  const override = overrides?.[field];

  if (override === "source") return "take_source";
  if (override === "canonical") return "keep_canonical";

  if (isProtectedClass(fieldClass)) return "review";
  if (fieldClass === "store_price") return "keep_source_local";
  if (fieldClass === "identity") return isBlank(canonical) ? "fill_blank" : "review";

  // Presentation.
  if (isBlank(canonical)) return "fill_blank";
  return resolveFieldOwner(policy, domain, field, overrides) === "source" ? "keep_source_local" : "keep_canonical";
}

/**
 * Compare a canonical record with an incoming one, field by field. Only fields
 * present on the incoming record are considered — an absent field in a partial
 * feed says nothing (absence is not deletion).
 */
export function diffFields(
  policy: FieldAuthorityPolicy,
  domain: ReconciliationDomain,
  canonical: Readonly<Record<string, unknown>>,
  incoming: Readonly<Record<string, unknown>>,
  overrides?: FieldAuthorityOverrides,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const field of Object.keys(incoming).sort()) {
    const action = resolveFieldAction(policy, domain, field, canonical[field], incoming[field], overrides);
    if (sameValue(canonical[field], incoming[field])) continue;
    conflicts.push({
      field,
      fieldClass: fieldClassFor(domain, field),
      canonical: canonical[field] ?? null,
      incoming: incoming[field] ?? null,
      action,
      needsReview: action === "review",
    });
  }
  return conflicts;
}

/** A stable fingerprint of a rejected remote value, so a rejected edit is not proposed — or pushed back — forever. */
export function remoteEditFingerprint(field: string, value: unknown): string {
  return `${field}=${value == null ? "" : typeof value === "string" ? value.trim() : JSON.stringify(value)}`;
}

/**
 * True when this exact remote value was already rejected for the field. An
 * unchanged rejected value is not re-raised as a conflict and is never echoed
 * back to the remote; a *different* remote value is a new edit and is judged
 * fresh.
 */
export function isRejectedRemoteEdit(rejected: ReadonlySet<string>, field: string, value: unknown): boolean {
  return rejected.has(remoteEditFingerprint(field, value));
}
