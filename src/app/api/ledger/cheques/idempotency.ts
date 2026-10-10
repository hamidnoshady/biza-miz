/**
 * The retry contract for the cheque endpoints.
 *
 * A money-moving request can be retried after an ambiguous failure — the
 * response was lost, not the write — and the second attempt must not post a
 * second entry. The caller says "this is the same request" by repeating a key,
 * either as the conventional `Idempotency-Key` header or as a body field for
 * clients that cannot set headers. Repeat the key and you get the first
 * result; omit it and the endpoint behaves exactly as it always has.
 */
import type { NextRequest } from "next/server";

/** Keys are opaque, but unbounded text in a unique index is not. */
const MAX_KEY_LENGTH = 200;

export function idempotencyKeyOf(request: NextRequest, fromBody?: unknown): string | null {
  const header = request.headers.get("idempotency-key");
  const raw = typeof fromBody === "string" && fromBody.trim() ? fromBody : header;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return null;
  return key.slice(0, MAX_KEY_LENGTH);
}
