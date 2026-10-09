import { describe, expect, it } from "vitest";
import {
  OperationKeyHolder,
  OperationKeyLimitError,
  operationSignature,
  outcomeOf,
} from "./operation-key";

/** A deterministic mint, so the assertions are about identity, not entropy. */
function holder() {
  let n = 0;
  return new OperationKeyHolder(() => `key-${++n}`);
}

describe("operationSignature", () => {
  it("is stable for the same values and different for a changed one", () => {
    expect(operationSignature(["a", 1, null])).toBe(operationSignature(["a", 1, null]));
    expect(operationSignature(["a", 1, null])).not.toBe(operationSignature(["a", 2, null]));
  });

  it("treats an omitted field and an explicitly empty one as the same request", () => {
    // The dialogs send `undefined` for "not filled in"; a payload rebuilt
    // from state may send `null` for the same thing. One request, one key.
    expect(operationSignature(["bounce", undefined])).toBe(operationSignature(["bounce", null]));
  });

  it("distinguishes order, so two fields cannot swap values unnoticed", () => {
    expect(operationSignature(["1404-01-01", 0])).not.toBe(operationSignature([0, "1404-01-01"]));
  });
});

describe("the key an operation keeps", () => {
  it("reuses the key while the payload is unchanged — a retry is the same request", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "bounce", "1404-12-20", 30_000]);
    expect(keys.keyFor(signature)).toBe("key-1");
    // The connection dropped; the user presses again. Same key, so a posting
    // that did commit is replayed instead of repeated.
    expect(keys.keyFor(signature)).toBe("key-1");
    expect(keys.keyFor(signature)).toBe("key-1");
  });

  it("starts a new operation as soon as an accounting field is edited", () => {
    const keys = holder();
    expect(keys.keyFor(operationSignature(["cheque-1", "bounce", "1404-12-20", 30_000]))).toBe(
      "key-1",
    );
    // The fee was wrong and the user corrected it. That is a different
    // request: re-sending it under the first key would be refused with
    // `idempotency_key_conflict` and the form could never be submitted.
    expect(keys.keyFor(operationSignature(["cheque-1", "bounce", "1404-12-20", 45_000]))).toBe(
      "key-2",
    );
  });

  it("gives the first key back when an edit is undone, because its fate is still unknown", () => {
    const keys = holder();
    const original = operationSignature(["cheque-1", "deposit", "1404-12-20", null]);
    const edited = operationSignature(["cheque-1", "deposit", "1404-12-21", null]);
    expect(keys.keyFor(original)).toBe("key-1");
    // The connection dropped, so nobody knows whether that deposit posted.
    keys.resolve(original, outcomeOf(undefined));
    expect(keys.keyFor(edited)).toBe("key-2");
    // Typing an edit is not evidence that the first attempt failed. Going
    // back to it must therefore go back to *its* key: minting a third one
    // would post a deposit that may already be on the books.
    expect(keys.keyFor(original)).toBe("key-1");
    expect(keys.unresolvedSignatures()).toEqual([original, edited]);
  });

  it("retires the key once the operation has committed", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "deposit", "1404-12-20", null]);
    expect(keys.keyFor(signature)).toBe("key-1");
    keys.resolve(signature, "committed");
    // A second, deliberate posting of an identical payload must be allowed to
    // happen — it is not a retry of the first one.
    expect(keys.keyFor(signature)).toBe("key-2");
    expect(keys.hasUnresolved()).toBe(true);
  });

  it("retires the key when the server refused the request in words", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "bounce", "1404-12-20", -1]);
    expect(keys.keyFor(signature)).toBe("key-1");
    // A 400 with an error code is the server saying it read the request and
    // wrote nothing. Resubmitting the identical payload later is new work.
    keys.resolve(signature, outcomeOf({ ok: false, status: 400 }));
    expect(keys.hasUnresolved()).toBe(false);
    expect(keys.keyFor(signature)).toBe("key-2");
  });

  it("keeps the key when the outcome is merely unknown", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "clear", null, null]);
    expect(keys.keyFor(signature)).toBe("key-1");
    for (const response of [
      undefined, // fetch threw / offline
      { ok: false, status: 0 }, // what api() reports for a dead connection
      { ok: false, status: 500 }, // the origin failed after it may have written
      { ok: false, status: 502 }, // a proxy answered, not the application
      { ok: false, status: 504 },
      { ok: false, status: 408 },
      { ok: false, status: 429 },
    ]) {
      keys.resolve(signature, outcomeOf(response));
      expect(keys.keyFor(signature)).toBe("key-1");
    }
  });

  it("only starts a new operation for an unresolved payload when told to", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "deposit", null, null]);
    expect(keys.keyFor(signature)).toBe("key-1");
    keys.resolve(signature, "unknown");
    expect(keys.keyFor(signature)).toBe("key-1");
    keys.startNewOperation(signature);
    expect(keys.keyFor(signature)).toBe("key-2");
  });

  it("holds several unresolved operations at once, oldest first", () => {
    const keys = holder();
    const a = operationSignature(["a"]);
    const b = operationSignature(["b"]);
    const c = operationSignature(["c"]);
    [a, b, c].forEach((signature) => keys.keyFor(signature));
    expect(keys.unresolvedSignatures()).toEqual([a, b, c]);
    keys.resolve(b, "committed");
    expect(keys.unresolvedSignatures()).toEqual([a, c]);
    expect(keys.keyFor(a)).toBe("key-1");
    expect(keys.keyFor(c)).toBe("key-3");
  });

  it("classifies outcomes from what the response proves", () => {
    expect(outcomeOf({ ok: true, status: 200 })).toBe("committed");
    expect(outcomeOf({ ok: false, status: 400 })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 403 })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 409 })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 404 })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 408 })).toBe("unknown");
    expect(outcomeOf({ ok: false, status: 429 })).toBe("unknown");
    expect(outcomeOf({ ok: false, status: 500 })).toBe("unknown");
    expect(outcomeOf({ ok: false, status: 0 })).toBe("unknown");
    expect(outcomeOf(undefined)).toBe("unknown");
  });

  it("keeps two different operations apart", () => {
    const keys = holder();
    const deposit = operationSignature(["cheque-1", "deposit", null, null]);
    const bounce = operationSignature(["cheque-1", "bounce", null, null]);
    expect(keys.keyFor(deposit)).toBe("key-1");
    expect(keys.keyFor(bounce)).toBe("key-2");
    // Both are still in flight, and each keeps its own identity.
    expect(keys.keyFor(deposit)).toBe("key-1");
    expect(keys.keyFor(bounce)).toBe("key-2");
  });

  it("mints a uuid by default", () => {
    const key = new OperationKeyHolder().keyFor("x");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("the holder under capacity pressure", () => {
  /** Mints predictable keys so an assertion can name the one it means. */
  function holder() {
    let n = 0;
    return new OperationKeyHolder(() => `key-${++n}`);
  }

  /** Thirty-two payloads whose outcome nobody knows. */
  function fillToCapacity(keys: OperationKeyHolder) {
    const signatures = Array.from({ length: 32 }, (_, i) => operationSignature(["cheque", i]));
    for (const signature of signatures) {
      keys.keyFor(signature);
      keys.resolve(signature, outcomeOf(undefined));
    }
    return signatures;
  }

  it("never forgets an unresolved payload to make room for a newer one", () => {
    const keys = holder();
    const [oldest] = fillToCapacity(keys);
    expect(keys.unresolvedSignatures()).toHaveLength(32);

    // The thirty-third *new* operation is refused rather than quietly
    // evicting the first. Dropping it would turn the retry below into a
    // second posting of a cheque that may already be on the books.
    expect(() => keys.keyFor(operationSignature(["cheque", "extra"]))).toThrow(
      OperationKeyLimitError,
    );
    expect(keys.canStartNewOperation()).toBe(false);
    expect(keys.unresolvedSignatures()).toHaveLength(32);

    // The oldest payload still has its original identity.
    expect(keys.keyFor(oldest)).toBe("key-1");
  });

  it("lets every held payload be retried while it is full", () => {
    const keys = holder();
    const signatures = fillToCapacity(keys);
    // A retry is never an additional operation, so it never throws, whatever
    // the size: being full must not brick the recovery path.
    signatures.forEach((signature, index) => {
      expect(keys.canStartNewOperation(signature)).toBe(true);
      expect(keys.keyFor(signature)).toBe(`key-${index + 1}`);
    });
  });

  it("accepts a new operation again as soon as one outcome is established", () => {
    const keys = holder();
    const signatures = fillToCapacity(keys);
    expect(() => keys.keyFor(operationSignature(["cheque", "extra"]))).toThrow(
      OperationKeyLimitError,
    );

    keys.resolve(signatures[0], "committed");
    expect(keys.canStartNewOperation()).toBe(true);
    expect(keys.keyFor(operationSignature(["cheque", "extra"]))).toBe("key-33");
    // …and the one that was resolved is gone, not merely displaced.
    expect(keys.unresolvedSignatures()).toHaveLength(32);
    expect(keys.unresolvedSignatures()).not.toContain(signatures[0]);
  });

  it("reports how full it is on the error it throws", () => {
    const keys = holder();
    fillToCapacity(keys);
    try {
      keys.keyFor(operationSignature(["cheque", "extra"]));
      throw new Error("expected the holder to refuse");
    } catch (err) {
      expect(err).toBeInstanceOf(OperationKeyLimitError);
      expect((err as OperationKeyLimitError).unresolved).toBe(32);
      expect((err as OperationKeyLimitError).limit).toBe(32);
    }
  });
});
