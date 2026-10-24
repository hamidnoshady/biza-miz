/**
 * Issue #933 item 13 — reading a JSON request body without trusting its shape.
 *
 * The route handlers mostly did `body = await request.json()` in a try/catch and
 * then read `body.openingFloat`. That is fine for `{}`, but a client that sends
 * `[]`, `null`, `"x"` or `42` either produced `undefined` for every field (so a
 * malformed request looked like an empty one) or reached the database and failed
 * there as a 500 instead of a 400. Arrays are the dangerous case for the shift
 * routes in particular: `[].closingFloat` is `undefined`, so an array body
 * silently became "close without a count".
 *
 * Empty bodies are still allowed for endpoints whose every field is optional;
 * the caller decides by checking whether it got `{}`.
 */

export type JsonObject = Record<string, unknown>;

export type JsonObjectResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: "bad_request" };

export async function readJsonObject(request: Request): Promise<JsonObjectResult> {
  // Read the text first so "no body" and "malformed JSON" can be told apart:
  // `request.json()` throws for both, and treating a truncated payload as an
  // empty body is how a half-sent close request became "close without count".
  const text = await request.text().catch(() => "");
  if (!text.trim()) return { ok: true, value: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "bad_request" };
  }
  // A *literal* JSON null is not an empty body: it is a client that sent a
  // value where an object was promised, and accepting it turns every field
  // into `undefined` — which for a close request means "no count".
  if (raw === null) return { ok: false, error: "bad_request" };
  if (raw === undefined) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_request" };
  return { ok: true, value: raw as JsonObject };
}

/**
 * The `Idempotency-Key` header, normalised. A retry of a start or close sends
 * the same key and gets the same committed result instead of a conflict.
 *
 * Returns `null` for an absent header, and `undefined` for a header that could
 * not be a sensible key (empty, too long) — the caller answers 400 rather than
 * silently ignoring it and writing a non-idempotent operation.
 */
export function idempotencyKey(request: Request): string | null | undefined {
  const raw = request.headers.get("idempotency-key");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  return trimmed;
}
