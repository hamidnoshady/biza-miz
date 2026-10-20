/**
 * Issue #913 — the identity pair behind exactly-once checkout.
 *
 * A till submission may be delivered twice (a lost response, a proxy retry, an
 * offline-queue replay after the server already committed) and the server has
 * to recognise the second delivery as the FIRST sale. `clientRequestId` is the
 * identity; this module derives the companion `request_fingerprint` that says
 * what that identity was *for*.
 *
 * Two rules, both enforced by the callers (order-mutations.ts,
 * retail-invoice-service.ts):
 *
 *   * same key + same fingerprint → return the original result, never a
 *     second insert;
 *   * same key + different fingerprint → hard conflict (409). Two genuinely
 *     different purchases must not be collapsed into one just because a stale
 *     screen reused a key, and a changed payload must not silently ride an
 *     already-committed sale.
 *
 * The fingerprint is a canonical (recursively key-sorted) serialization of the
 * *business intent only* — never the key itself, never replay mechanics
 * (order ids, line ids, actor, clock). The direct HTTP body and the offline
 * queue's replay payload are the same JSON the client sent, so both routes
 * through createOrder derive the same tuple; key order, undefined-vs-missing
 * and numeric formatting cannot make a retry look like a new purchase.
 *
 * Framework-free and side-effect-free, like permissions.ts — unit-tested
 * directly (checkout-idempotency.test.ts).
 */
import { createHash } from "node:crypto";

/** Recursively key-sorted JSON: `{a,b}` and `{b,a}` serialize identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  if (value === undefined) return null;
  return value;
}

function sha256(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/** Normalizes a caller-supplied key: trimmed, ≤200 chars (0129/0232 checks), or null. */
export function normalizeClientRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 200) return null;
  return key;
}

/** An invalid key is a 400, not a silently-dropped one — used by routes. */
export function isValidClientRequestId(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
}

/**
 * The fingerprint of one F&B order submission, over createOrder's *normalized*
 * input so the synchronous POST /api/orders route and the offline queue's
 * order.create replay (sync-events.ts) derive the same value from the same
 * client payload. Deliberately excludes: the key, location (the dedupe scope
 * already carries it), the actor (who presses send is not what is being
 * sent), replay ids (orderId/itemIds/openedAt) and the wall clock.
 */
export function orderRequestFingerprint(input: {
  type?: unknown;
  tableId?: unknown;
  customerId?: unknown;
  guestCount?: unknown;
  note?: unknown;
  discount?: unknown;
  items?: unknown;
  delivery?: unknown;
}): string {
  return sha256(
    JSON.stringify(
      canonicalize({
        type: input.type ?? null,
        tableId: input.tableId ?? null,
        customerId: input.customerId ?? null,
        guestCount: input.guestCount ?? null,
        note: input.note ?? null,
        discount: input.discount ?? null,
        items: input.items ?? [],
        delivery: input.delivery ?? null,
      }),
    ),
  );
}

/**
 * The fingerprint of one retail-invoice submission, over the service's
 * normalized input (the route has already parsed tenders into Rial text, so
 * number formatting cannot differ between an attempt and its retry).
 * businessDate/createdBy are excluded: the same purchase retried after
 * midnight or by a colleague is still the same purchase.
 */
export function retailInvoiceRequestFingerprint(input: {
  lines?: unknown;
  tenders?: unknown;
  customerId?: unknown;
  note?: unknown;
}): string {
  return sha256(
    JSON.stringify(
      canonicalize({
        lines: input.lines ?? [],
        tenders: input.tenders ?? [],
        customerId: input.customerId ?? null,
        note: input.note ?? null,
      }),
    ),
  );
}
