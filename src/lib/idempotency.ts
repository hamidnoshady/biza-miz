/**
 * Issue #933 — a client idempotency key for a deliberate, retryable write.
 *
 * A double click, a proxy timeout the browser retried, or a flaky mobile
 * connection must not turn one shift close (or one business-day close) into two
 * different answers — the second has no open row left to find and would report
 * failure for work that succeeded. The key names the *intent*, so the server can
 * return the committed result.
 *
 * `crypto.randomUUID` needs a secure context; the fallback keeps a plain-http
 * dev server working. It is a nonce, not a credential — nothing is derived from
 * it beyond de-duplication.
 */
export function newIdempotencyKey(prefix = "req"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
