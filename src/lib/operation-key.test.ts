import { describe, expect, it } from "vitest";
import { OperationKeyHolder, operationSignature } from "./operation-key";

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

  it("goes back to the first key if the edit is undone", () => {
    const keys = holder();
    const original = operationSignature(["cheque-1", "deposit", "1404-12-20", null]);
    const edited = operationSignature(["cheque-1", "deposit", "1404-12-21", null]);
    expect(keys.keyFor(original)).toBe("key-1");
    expect(keys.keyFor(edited)).toBe("key-2");
    // Only the latest operation is held: returning to the original payload is
    // a fresh operation too, which is the safe direction to err in — it can
    // only ever post something that was never posted.
    expect(keys.keyFor(original)).toBe("key-3");
  });

  it("retires the key once the operation has committed", () => {
    const keys = holder();
    const signature = operationSignature(["cheque-1", "deposit", "1404-12-20", null]);
    expect(keys.keyFor(signature)).toBe("key-1");
    keys.settle();
    // A second, deliberate posting of an identical payload must be allowed to
    // happen — it is not a retry of the first one.
    expect(keys.keyFor(signature)).toBe("key-2");
  });

  it("keeps two different operations apart", () => {
    const keys = holder();
    const deposit = operationSignature(["cheque-1", "deposit", null, null]);
    const bounce = operationSignature(["cheque-1", "bounce", null, null]);
    expect(keys.keyFor(deposit)).toBe("key-1");
    expect(keys.keyFor(bounce)).toBe("key-2");
    expect(keys.keyFor(deposit)).toBe("key-3");
  });

  it("mints a uuid by default", () => {
    const key = new OperationKeyHolder().keyFor("x");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
