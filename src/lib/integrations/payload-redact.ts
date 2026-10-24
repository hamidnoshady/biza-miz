/**
 * Issue #942 (F13) — diagnostics payloads, made safe to show.
 *
 * The queue's list used to return every row's full JSON body, and the UI
 * rendered it raw: an order payload carries the customer's name, phone,
 * email and address; a mis-sent payload can carry credentials. The list now
 * carries metadata only, and the per-row diagnostics endpoint returns the
 * payload through this module — credentials removed outright, contact
 * details partially masked, size bounded so one pathological payload cannot
 * produce an unbounded response.
 *
 * Pure, so the masking rules are unit-tested directly.
 */

const MASK = "•••";

/** Keys whose value is a credential — never shown, not even partially. */
const SECRET_KEY_RE =
  /pass(word)?|secret|token|authorization|auth|api[-_]?key|consumer[-_]?key|consumer[-_]?secret|credential|nonce|signature|cookie|session|private[-_]?key|card|iban|account[-_]?number/i;

/** Keys whose value is customer contact data — masked but recognisable. */
const CONTACT_KEY_RE = /^(email|user_email|phone|mobile|telephone|billing_email|billing_phone|shipping_phone)$/i;

function maskContact(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const at = trimmed.indexOf("@");
  if (at > 0) {
    // email: keep the first character and the domain shape.
    return `${trimmed.slice(0, 1)}${MASK}@${MASK}${trimmed.slice(at).replace(/^@[^.]*/, "")}`;
  }
  // phone-ish: keep the first two and last two characters.
  if (trimmed.length <= 6) return MASK;
  return `${trimmed.slice(0, 2)}${MASK}${trimmed.slice(-2)}`;
}

export interface RedactOptions {
  /** Deepest nesting kept; deeper structures collapse to a placeholder. */
  maxDepth?: number;
  /** Longest string kept verbatim; longer strings are truncated. */
  maxStringLength?: number;
  /** Most entries kept in one object/array. */
  maxEntries?: number;
}

export function redactPayload(value: unknown, options?: RedactOptions): unknown {
  const maxDepth = options?.maxDepth ?? 6;
  const maxStringLength = options?.maxStringLength ?? 500;
  const maxEntries = options?.maxEntries ?? 60;
  return redactValue(value, "", 0, maxDepth, maxStringLength, maxEntries);
}

function redactValue(
  value: unknown,
  key: string,
  depth: number,
  maxDepth: number,
  maxStringLength: number,
  maxEntries: number,
): unknown {
  if (key && SECRET_KEY_RE.test(key)) return MASK;

  if (typeof value === "string") {
    if (key && CONTACT_KEY_RE.test(key)) return maskContact(value);
    // Bearer tokens and basic-auth blobs smuggled inside a free-text value.
    if (/bearer\s+\S+/i.test(value)) return value.replace(/bearer\s+\S+/gi, `Bearer ${MASK}`);
    if (value.length > maxStringLength) return `${value.slice(0, maxStringLength)}…`;
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= maxDepth) return "…";

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxEntries)
      .map((item) => redactValue(item, key, depth + 1, maxDepth, maxStringLength, maxEntries));
    if (value.length > maxEntries) kept.push(`… +${value.length - maxEntries} مورد دیگر`);
    return kept;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of entries.slice(0, maxEntries)) {
    out[childKey] = redactValue(childValue, childKey, depth + 1, maxDepth, maxStringLength, maxEntries);
  }
  if (entries.length > maxEntries) out.__truncated = `+${entries.length - maxEntries} فیلد دیگر`;
  return out;
}

/** Cap an error string for list display — the full text can be huge (HTML 500s). */
export function capQueueError(error: string | null, max = 500): string | null {
  if (!error) return error;
  // An error string can echo a request back (headers included); apply the
  // same bearer-token scrub as payloads before it reaches the browser.
  const scrubbed = error.replace(/bearer\s+\S+/gi, `Bearer ${MASK}`);
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}
