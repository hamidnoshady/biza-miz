/**
 * Operation keys — one key per *operation*, not per attempt.
 *
 * The server treats an idempotency key as the identity of a money-moving
 * request: the same key with the same payload replays the first result, and
 * the same key with a *different* payload is refused (`idempotency_key_conflict`)
 * rather than silently answered. That contract is only worth anything if the
 * client holds its side of it, and holding it has two halves that pull in
 * opposite directions:
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
 *   or the fee after a rejection and submits again, that is a different
 *   request. Re-sending it under the old key would be answered with a 409 and
 *   leave them stuck on a form the server will never accept.
 *
 * The rule that satisfies both: **the key is a function of the payload.** A
 * signature is built from the operation's target, its action and every
 * accounting-significant field — the same inputs the server fingerprints — and
 * a key is minted the first time a signature is seen and reused for as long as
 * it stays the same. Change a field and the signature changes, so a new
 * operation (and a new key) begins. Succeed, and the key is retired: the next
 * submission of an identical payload is a deliberate second posting, not a
 * retry, and must be allowed to happen.
 *
 * Cosmetic fields stay out of the signature for the same reason the server
 * keeps them out of its fingerprint: re-sending a retry with a tidied-up memo
 * is still the same posting.
 */

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
 * Keeps the key belonging to the operation currently being attempted.
 *
 * Only one is held: these are modal, one-at-a-time flows (a confirmation
 * dialog, a registration form), and remembering keys for operations the user
 * has moved on from would hand a stale key to a later, unrelated submission.
 */
export class OperationKeyHolder {
  private current: { signature: string; key: string } | null = null;

  constructor(private readonly mint: () => string = () => crypto.randomUUID()) {}

  /** The key for this payload: the one already in flight, or a new one. */
  keyFor(signature: string): string {
    if (this.current?.signature === signature) return this.current.key;
    const key = this.mint();
    this.current = { signature, key };
    return key;
  }

  /**
   * The operation finished. The next submission starts a new one — including
   * a byte-identical one, which is then a second deliberate posting.
   */
  settle(): void {
    this.current = null;
  }
}
