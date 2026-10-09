/**
 * Operation keys — one key per *operation*, kept until its outcome is known.
 *
 * The server treats an idempotency key as the identity of a money-moving
 * request: the same key with the same payload replays the first result, and
 * the same key with a *different* payload is refused
 * (`idempotency_key_conflict`) rather than silently answered. That contract is
 * only worth anything if the client holds its side of it, and holding it has
 * three parts:
 *
 * - **A retry must reuse the key.** A dropped connection, a timeout or a
 *   gateway error leaves the caller unable to tell whether the posting
 *   committed. Minting a fresh key for the second press turns that ambiguity
 *   into a duplicate cheque or a duplicate step — the exact failure the key
 *   exists to prevent. The ledger studio's `run()` surfaces such a failure to
 *   the user and does not retry internally, so the *user's* second press is
 *   the retry, and it has to carry the first key.
 *
 * - **An edit must not reuse it.** If the user corrects the amount, the date
 *   or the fee and submits again, that is a different request. Re-sending it
 *   under the old key would be answered with a 409 and leave them stuck on a
 *   form the server will never accept.
 *
 * - **An edit must not *abandon* the old one either.** This is the part the
 *   first version got wrong. It remembered only the latest payload, so
 *   A → B → A minted three keys: the moment the user edited away from a
 *   payload whose fate was unknown, that payload's retry identity was gone,
 *   and going back to it posted it again under a new key. Editing a form is
 *   not evidence that the earlier request failed.
 *
 * So the holder keeps **every payload whose outcome is still unknown**, keyed
 * by its signature, and only forgets one when the outcome is *established*:
 *
 * | Outcome | How it is known | What happens to the key |
 * | --- | --- | --- |
 * | committed | a success response | retired — an identical payload submitted again is a second, deliberate posting |
 * | rejected | a response the server chose to send with a validation/permission error | retired — the server proved it wrote nothing, so a corrected resubmission is new work |
 * | unknown | the request threw, timed out, or came back 5xx/502/504 | **kept** — the next identical submission is a retry and carries the same key |
 *
 * A 5xx is deliberately *not* treated as a rejection: a proxy can return 502
 * after the origin committed, and the whole point of the key is that the
 * client does not have to guess. Nothing is lost by keeping it — a key whose
 * work never committed simply never matches anything server-side.
 *
 * Closing and reopening a dialog, or typing an edit and undoing it, therefore
 * preserves the identity of a request that may already have posted. Starting a
 * deliberately new operation with the same payload is possible, but it has to
 * be *said*: either the previous one is known to have committed (the holder
 * retires it), or the caller calls `startNewOperation(signature)`.
 *
 * Cosmetic fields stay out of the signature for the same reason the server
 * keeps them out of its fingerprint: re-sending a retry with a tidied-up memo
 * is still the same posting.
 */

/** What became of a request — the two outcomes that are actually *known*. */
export type OperationOutcome = "committed" | "rejected";

/**
 * How many unresolved operations one holder remembers.
 *
 * These are modal, one-at-a-time flows, so the realistic count is one or two;
 * the cap exists only so a pathological session cannot grow without bound. The
 * oldest unresolved entry is dropped first, and it is dropped from the *client*
 * only — the server still holds its key, so nothing becomes re-postable that
 * was not already.
 */
const MAX_UNRESOLVED = 32;

/**
 * A stable string for a set of values.
 *
 * `JSON.stringify` over an array, not an object: array order is fixed by the
 * caller, whereas object key order is a property of how the object happened to
 * be built. `undefined` and `null` both collapse to `null` so that "field
 * omitted" and "field explicitly empty" cannot produce two keys for one
 * request.
 */
export function operationSignature(parts: readonly unknown[]): string {
  return JSON.stringify(parts.map((part) => (part === undefined ? null : part)));
}

/**
 * Classifies a finished attempt.
 *
 * `response` is whatever the caller got back; `undefined` means the request
 * never produced one (it threw). Only a response the *application* chose to
 * send — a 4xx carrying an error code — proves that nothing was written.
 */
export function outcomeOf(
  response: { ok: boolean; status?: number } | undefined,
): OperationOutcome | "unknown" {
  if (!response) return "unknown";
  if (response.ok) return "committed";
  const status = response.status ?? 0;
  // 408 Request Timeout and 429 are retries of the same request, not verdicts
  // on it; everything else in the 4xx range is the server saying "I read this
  // and I refuse it", which it cannot say after having written anything.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "unknown";
}

/**
 * Holds the idempotency key of every operation whose outcome is still unknown.
 */
export class OperationKeyHolder {
  /** Insertion-ordered: signature → the key that request went out with. */
  private readonly unresolved = new Map<string, string>();

  constructor(private readonly mint: () => string = () => crypto.randomUUID()) {}

  /**
   * The key for this payload: the one an unresolved attempt already used, or a
   * new one.
   */
  keyFor(signature: string): string {
    const existing = this.unresolved.get(signature);
    if (existing) return existing;
    const key = this.mint();
    this.unresolved.set(signature, key);
    if (this.unresolved.size > MAX_UNRESOLVED) {
      const oldest = this.unresolved.keys().next();
      if (!oldest.done) this.unresolved.delete(oldest.value);
    }
    return key;
  }

  /**
   * Record what became of an attempt. An `"unknown"` outcome is the one that
   * keeps the key, so callers may pass it through from `outcomeOf` without
   * branching.
   */
  resolve(signature: string, outcome: OperationOutcome | "unknown"): void {
    if (outcome === "unknown") return;
    this.unresolved.delete(signature);
  }

  /**
   * Deliberately begin a *new* operation for a payload, discarding the
   * unresolved attempt's identity.
   *
   * This is the escape hatch for "I know the first one did not post and I want
   * to send it again as new work" — it must be an explicit act, never a
   * side-effect of closing a dialog, because it is the one call that can turn
   * a retry into a duplicate posting.
   */
  startNewOperation(signature: string): void {
    this.unresolved.delete(signature);
  }

  /** Whether any attempt is still waiting for its outcome. */
  hasUnresolved(): boolean {
    return this.unresolved.size > 0;
  }

  /** The signatures still waiting for an outcome, oldest first. */
  unresolvedSignatures(): string[] {
    return [...this.unresolved.keys()];
  }
}
