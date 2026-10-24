import { describe, expect, it } from "vitest";
import { idempotencyKey, readJsonObject } from "./request-json";

function request(body: string | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body: body === null ? undefined : body,
    // `Request` refuses a body for GET/HEAD, but these are POSTs; nothing else
    // is needed for the parser.
  });
}

describe("readJsonObject", () => {
  it("reads an object body", async () => {
    await expect(readJsonObject(request('{"countedCash":5000}'))).resolves.toEqual({
      ok: true,
      value: { countedCash: 5000 },
    });
  });

  it("treats a missing body as an empty object", async () => {
    await expect(readJsonObject(request(null))).resolves.toEqual({ ok: true, value: {} });
  });

  it("refuses an array, a literal null and a primitive (#933 item 13)", async () => {
    for (const bad of ["[]", "[1,2]", "null", '"text"', "42", "true"]) {
      await expect(readJsonObject(request(bad)), bad).resolves.toEqual({ ok: false, error: "bad_request" });
    }
  });

  it("refuses malformed JSON", async () => {
    await expect(readJsonObject(request("{oops"))).resolves.toEqual({ ok: false, error: "bad_request" });
  });
});

describe("idempotencyKey", () => {
  it("returns null when absent, the trimmed key when present", () => {
    expect(idempotencyKey(request(null))).toBeNull();
    expect(idempotencyKey(request(null, { "idempotency-key": "  abc  " }))).toBe("abc");
  });

  it("returns undefined for a useless key rather than silently ignoring it", () => {
    expect(idempotencyKey(request(null, { "idempotency-key": "   " }))).toBeUndefined();
    expect(idempotencyKey(request(null, { "idempotency-key": "x".repeat(201) }))).toBeUndefined();
  });
});
