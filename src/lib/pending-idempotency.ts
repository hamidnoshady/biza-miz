/**
 * Issue #915 — a pending idempotency key that survives reloads.
 *
 * The retail purchase/return forms generate a client idempotency key so a
 * network retry replays the original receipt instead of writing a second
 * one. Holding that key only in component state left one gap: a page reload
 * or re-login between "request sent" and "response seen" produced a fresh
 * key, so resubmitting the same form after a reload could duplicate the
 * document. The key is therefore persisted (sessionStorage) under a
 * fingerprint of the payload until the outcome is known:
 *
 * - same payload again (reload, reconnect) → the SAME key is reused, and the
 *   server answers from the original receipt (`duplicate: true`);
 * - the payload changed → the stored entry no longer matches and a fresh key
 *   is issued (a different request must never reuse a spent key);
 * - success or a terminal validation error → the entry is cleared.
 *
 * Pure over an injected Storage so it unit-tests without a browser; callers
 * pass `window.sessionStorage` (per-tab, clears when the tab closes — the
 * right lifetime for "until the outcome of this submission is known").
 */

/** FNV-1a over the canonical JSON of the payload — stable across reloads. */
export function payloadFingerprint(payload: unknown): string {
  const text = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0") + ":" + text.length.toString(16);
}

interface StoredPendingKey {
  fingerprint: string;
  key: string;
}

function storageKey(scope: string): string {
  return `pending-idempotency:${scope}`;
}

function read(storage: Pick<Storage, "getItem">, scope: string): StoredPendingKey | null {
  try {
    const raw = storage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPendingKey;
    if (typeof parsed?.fingerprint !== "string" || typeof parsed?.key !== "string" || !parsed.key) return null;
    return parsed;
  } catch {
    // Unreadable storage (privacy mode, corrupted entry) must never block a
    // submission — the caller just gets a fresh key, same as before #915.
    return null;
  }
}

/**
 * The idempotency key to send for `payload`: the stored pending key when the
 * payload is byte-identical to the one that created it, otherwise a fresh
 * key persisted in its place.
 */
export function pendingIdempotencyKey(
  storage: Pick<Storage, "getItem" | "setItem">,
  scope: string,
  payload: unknown,
  generate: () => string = () => crypto.randomUUID(),
): string {
  const fingerprint = payloadFingerprint(payload);
  const stored = read(storage, scope);
  if (stored && stored.fingerprint === fingerprint) return stored.key;
  const key = generate();
  try {
    storage.setItem(storageKey(scope), JSON.stringify({ fingerprint, key } satisfies StoredPendingKey));
  } catch {
    // Quota/privacy failures degrade to the pre-#915 in-memory behaviour.
  }
  return key;
}

/** Forget the pending key once the submission's outcome is known. */
export function clearPendingIdempotencyKey(storage: Pick<Storage, "removeItem">, scope: string): void {
  try {
    storage.removeItem(storageKey(scope));
  } catch {
    // Nothing to do — the entry will be superseded by the next fingerprint.
  }
}
