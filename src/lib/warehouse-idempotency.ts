/**
 * Canonical payload hashing for warehouse documents (F&B + Retail).
 *
 * Deep-canonical: sorted keys at every level, normalised string values
 * (trim, empty→null), ordered lines, no replacer-array filtering.
 *
 * Same key + same payload → same hash → returns original voucher.
 * Same key + changed payload → 409 idempotency_key_conflict.
 */
import { createHash } from "node:crypto";

type Primitive = string | number | boolean | null;

function normalizeString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeValue(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number") {
    // Whole-Rial integers only for unitCost, but normalise anyway
    if (!Number.isFinite(value)) return String(value);
    return String(value);
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") return sortKeysDeep(value as Record<string, unknown>);
  return value;
}

function sortKeysDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const v = obj[k];
    if (v == null) {
      sorted[k] = null;
    } else if (Array.isArray(v)) {
      sorted[k] = v.map((item) => {
        if (item == null) return null;
        if (typeof item === "object" && !Array.isArray(item)) {
          return sortKeysDeep(item as Record<string, unknown>);
        }
        return normalizeValue(item);
      });
    } else if (typeof v === "object") {
      sorted[k] = sortKeysDeep(v as Record<string, unknown>);
    } else if (typeof v === "string") {
      sorted[k] = normalizeString(v);
    } else {
      sorted[k] = v;
    }
  }
  return sorted;
}

export function canonicalHash(payload: unknown): string {
  // Normalise payload: trim strings, null for empty, sort keys deep
  // First sort lines if present, then deep-sort
  const normalized = normalizePayload(payload);
  const sorted = sortKeysDeep(normalized as Record<string, unknown>);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function normalizePayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return normalizeValue(payload);
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "lines" && Array.isArray(v)) {
      // Sort lines deterministically by item identifier + lot
      const lines = [...(v as Array<Record<string, unknown>>)];
      lines.sort((a, b) => {
        const aItem = String(a.inventoryItemId ?? a.itemId ?? a.item ?? "");
        const bItem = String(b.inventoryItemId ?? b.itemId ?? b.item ?? "");
        if (aItem !== bItem) return aItem.localeCompare(bItem);
        const aLot = String(a.lot ?? a.lotNumber ?? a.batchNumber ?? "");
        const bLot = String(b.lot ?? b.lotNumber ?? b.batchNumber ?? "");
        if (aLot !== bLot) return aLot.localeCompare(bLot);
        const aQty = String(a.quantity ?? "");
        const bQty = String(b.quantity ?? "");
        return aQty.localeCompare(bQty);
      });
      out[k] = lines.map((line) => {
        // Normalise each line's fields: trim, empty→null, quantities as strings
        const n: Record<string, unknown> = {};
        for (const [lk, lv] of Object.entries(line)) {
          if (lk === "quantity" || lk === "unitCost") {
            if (lv == null) n[lk] = null;
            else if (typeof lv === "number") n[lk] = String(lv);
            else n[lk] = normalizeString(lv as string) ?? String(lv);
          } else if (lk === "lot" || lk === "lotNumber" || lk === "batchNumber") {
            n[lk] = normalizeString(lv);
          } else if (lk === "expiry" || lk === "expiryDate") {
            n[lk] = normalizeString(lv);
          } else if (lk === "itemId" || lk === "inventoryItemId") {
            n[lk] = normalizeString(lv);
          } else {
            n[lk] = normalizeValue(lv);
          }
        }
        // Ensure canonical keys: sort them later, but also include all present
        return n;
      });
    } else {
      // Normalise top-level fields
      if (v == null) out[k] = null;
      else if (typeof v === "string") out[k] = normalizeString(v);
      else out[k] = normalizeValue(v);
    }
  }
  return out;
}

/**
 * Build the canonical payload for collection POSTs.
 *
 * Fields per spec: kind, locationId, supplierId, recipient, documentNumber,
 * note, freeGoodsReason, postingDate and full ordered lines
 * (item/batch, quantity, unitCost, lot, expiry).
 */
export function buildCollectionPayloadHash(input: {
  kind: string;
  locationId: unknown;
  supplierId?: unknown;
  recipient?: unknown;
  documentNumber?: unknown;
  note?: unknown;
  freeGoodsReason?: unknown;
  postingDate?: unknown;
  lines: Array<{
    inventoryItemId?: unknown;
    itemId?: unknown;
    quantity?: unknown;
    unitCost?: unknown;
    lot?: unknown;
    lotNumber?: unknown;
    expiryDate?: unknown;
    expiry?: unknown;
  }>;
}): string {
  const payload = {
    kind: normalizeString(input.kind),
    locationId: normalizeString(input.locationId),
    supplierId: normalizeString(input.supplierId),
    recipient: normalizeString(input.recipient),
    documentNumber: normalizeString(input.documentNumber),
    note: normalizeString(input.note),
    freeGoodsReason: normalizeString(input.freeGoodsReason),
    postingDate: normalizeString(input.postingDate),
    lines: input.lines.map((l) => ({
      inventoryItemId: l.inventoryItemId != null ? normalizeString(l.inventoryItemId) : undefined,
      itemId: l.itemId != null ? normalizeString(l.itemId) : undefined,
      quantity: l.quantity != null ? String(l.quantity).trim() : null,
      unitCost: l.unitCost != null ? String(l.unitCost).trim() : null,
      lot: normalizeString((l.lot ?? l.lotNumber) as unknown),
      expiry: normalizeString((l.expiryDate ?? l.expiry) as unknown),
    })),
  };
  return canonicalHash(payload);
}

/**
 * Build the canonical payload for reversal POSTs.
 *
 * Same machinery as the collection hash — `canonicalHash` sorts keys at every
 * level and normalises strings (trimmed, nullish → `null`) — over the fields a
 * reversal actually decides: which document is being reversed, the free-text
 * note, and the recorded reason. The lines are not repeated here because they
 * are derived from `originalId` (the reversed voucher's own snapshotted lines),
 * so the id pins them.
 *
 * A retry that repeats all three returns the original reversal; changing any
 * one of them is a different act and answers `idempotency_key_conflict` rather
 * than silently returning a voucher that says something else.
 */
export function buildReversalPayloadHash(input: {
  originalId: string;
  note?: unknown;
  reason?: unknown;
}): string {
  const payload = {
    originalId: normalizeString(input.originalId),
    note: normalizeString(input.note),
    reason: normalizeString(input.reason),
  };
  return canonicalHash(payload);
}

export function isValidIdempotencyKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  if (key.trim() === "") return false;
  // Must be UUID v4 (or any UUID per isUuid helper). We do basic regex here
  // to avoid importing isUuid which does same check; keep consistent.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key.trim());
}
