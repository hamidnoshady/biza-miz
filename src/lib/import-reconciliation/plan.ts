/**
 * Batch planning — pure (server-side: it hashes with node:crypto, so a client
 * component imports `types.ts` / `lifecycle.ts`, never this file).
 *
 * `plan*` turns one bounded batch of incoming records into `PlannedItem`s: the
 * verdict, the evidence, the field-level diff and a per-record fingerprint. The
 * service stages exactly what comes out of here and nothing else, which is what
 * makes a preview a faithful (and write-free) account of what an apply would do.
 */

import { createHash } from "node:crypto";
import { diffFields, type FieldAuthorityPolicy } from "./field-authority";
import { normalizeBarcodeKey, normalizeSkuKey, normalizePhoneKey } from "./normalize";
import {
  resolveFinancialDocument,
  resolveInventory,
  resolveParty,
  resolveProduct,
  snapshotKey,
  type FinancialDocumentContext,
  type InventoryContext,
  type PartyContext,
  type ProductContext,
} from "./resolvers";
import type {
  FieldConflict,
  IncomingFinancialDocument,
  IncomingInventory,
  IncomingParty,
  IncomingProduct,
  IncomingRecord,
  ReconciliationDomain,
  Resolution,
} from "./types";

export interface PlannedItem {
  domain: ReconciliationDomain;
  /** The entity type within the domain, e.g. `product`, `invoice`, `snapshot`. */
  externalType: string;
  /** `externalId`, or `row:<n>` for a file row without an id column. */
  externalKey: string;
  rowNumber: number | null;
  /** Stable hash of the incoming record; a re-sent identical record is a no-op. */
  fingerprint: string;
  record: IncomingRecord;
  resolution: Resolution;
  conflicts: FieldConflict[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function recordFingerprint(record: IncomingRecord): string {
  return createHash("sha256").update(stableStringify(record)).digest("hex");
}

export function externalKeyOf(record: IncomingRecord): string {
  return record.externalId ?? `row:${record.rowNumber ?? 0}`;
}

function externalTypeOf(record: IncomingRecord): string {
  switch (record.domain) {
    case "product": return "product";
    case "party": return "party";
    case "financial_document": return record.kind;
    case "inventory": return record.kind;
  }
}

function countKeys(values: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/**
 * A linked or matched record whose protected fields disagree is a
 * `field_conflict`: the link is real, but a person has to look before any
 * field moves. A conflict the policy settles by itself (a blank filled, a
 * presentation field kept source-local) does not change the verdict.
 */
function withFieldConflicts(resolution: Resolution, conflicts: FieldConflict[]): Resolution {
  const linked = resolution.outcome === "already_linked" || resolution.outcome === "safe_match";
  if (linked && conflicts.some((c) => c.needsReview)) {
    return { ...resolution, outcome: "field_conflict", reasons: [...resolution.reasons] };
  }
  return resolution;
}

function toItem(record: IncomingRecord, resolution: Resolution, conflicts: FieldConflict[]): PlannedItem {
  return {
    domain: record.domain,
    externalType: externalTypeOf(record),
    externalKey: externalKeyOf(record),
    rowNumber: record.rowNumber ?? null,
    fingerprint: recordFingerprint(record),
    record,
    resolution: withFieldConflicts(resolution, conflicts),
    conflicts,
  };
}

/** The canonical field values of a linked row, for the field diff. Null ⇒ no diff possible. */
export type CanonicalFieldReader = (canonicalId: string) => Readonly<Record<string, unknown>> | null;

function conflictsFor(
  domain: ReconciliationDomain,
  resolution: Resolution,
  incomingFields: Readonly<Record<string, unknown>> | undefined,
  policy: FieldAuthorityPolicy,
  readCanonical: CanonicalFieldReader | undefined,
): FieldConflict[] {
  if (!incomingFields || !resolution.canonicalId || !readCanonical) return [];
  if (resolution.outcome !== "already_linked" && resolution.outcome !== "safe_match") return [];
  const canonical = readCanonical(resolution.canonicalId);
  return canonical ? diffFields(policy, domain, canonical, incomingFields) : [];
}

export interface PlanOptions {
  policy: FieldAuthorityPolicy;
  readCanonical?: CanonicalFieldReader;
}

export function planProducts(
  records: readonly IncomingProduct[],
  base: Omit<ProductContext, "incomingSkuCounts" | "incomingBarcodeCounts">,
  options: PlanOptions,
  /** Counts over the WHOLE run when the batch is a slice of it; defaults to this batch. */
  wholeRun: readonly IncomingProduct[] = records,
): PlannedItem[] {
  const ctx: ProductContext = {
    ...base,
    incomingSkuCounts: countKeys(wholeRun.map((r) => normalizeSkuKey(r.sku))),
    incomingBarcodeCounts: countKeys(wholeRun.flatMap((r) => (r.barcodes ?? []).map(normalizeBarcodeKey))),
  };
  return records.map((record) => {
    const resolution = resolveProduct(record, ctx);
    return toItem(record, resolution, conflictsFor("product", resolution, record.fields, options.policy, options.readCanonical));
  });
}

export function planParties(
  records: readonly IncomingParty[],
  base: Omit<PartyContext, "incomingPhoneCounts">,
  options: PlanOptions,
  wholeRun: readonly IncomingParty[] = records,
): PlannedItem[] {
  const ctx: PartyContext = {
    ...base,
    incomingPhoneCounts: countKeys(wholeRun.map((r) => normalizePhoneKey(r.phone))),
  };
  return records.map((record) => {
    const resolution = resolveParty(record, ctx);
    return toItem(record, resolution, conflictsFor("party", resolution, record.fields, options.policy, options.readCanonical));
  });
}

export function planFinancialDocuments(
  records: readonly IncomingFinancialDocument[],
  ctx: FinancialDocumentContext,
  _options?: PlanOptions,
): PlannedItem[] {
  return records.map((record) => toItem(record, resolveFinancialDocument(record, ctx), []));
}

export function planInventory(
  records: readonly IncomingInventory[],
  base: Omit<InventoryContext, "incomingSnapshotCounts">,
  _options?: PlanOptions,
  wholeRun: readonly IncomingInventory[] = records,
): PlannedItem[] {
  const ctx: InventoryContext = {
    ...base,
    incomingSnapshotCounts: countKeys(
      wholeRun
        .filter((r) => r.kind === "snapshot" && r.productExternalId)
        .map((r) => snapshotKey(r.productExternalId as string, r.locationKey)),
    ),
  };
  return records.map((record) => toItem(record, resolveInventory(record, ctx), []));
}

/**
 * The normalised keys under which a record can collide with another record of
 * the same run — stored on the staged row so duplicates that land in different
 * bounded batches are still found (`duplicate_in_source`).
 */
export function identityKeysOf(record: IncomingRecord): string[] {
  const keys: string[] = [];
  switch (record.domain) {
    case "product": {
      const sku = normalizeSkuKey(record.sku);
      if (sku) keys.push(`sku:${sku}`);
      for (const b of record.barcodes ?? []) {
        const barcode = normalizeBarcodeKey(b);
        if (barcode) keys.push(`barcode:${barcode}`);
      }
      break;
    }
    case "party": {
      const phone = normalizePhoneKey(record.phone);
      if (phone) keys.push(`phone:${phone}`);
      break;
    }
    case "inventory":
      if (record.kind === "snapshot" && record.productExternalId) {
        keys.push(`snapshot:${snapshotKey(record.productExternalId, record.locationKey)}`);
      }
      break;
    case "financial_document":
      break;
  }
  return [...new Set(keys)];
}
