/**
 * Issue #866 — the route helpers every `/api/ledger/tax-invoices` handler shares.
 * A service refusal must reach the screen as its own status and Persian message,
 * an unknown failure must not be dressed up as a refusal, and a register query
 * outside the vocabulary must be a 400 rather than a silently wider list.
 */
import { describe, expect, it } from "vitest";
import { readJsonBody, registerFiltersFromSearch, stringArray, taxErrorResponse } from "./tax-invoice-http";
import { TaxServiceError } from "./tax-invoice-service";

const LOCATION = "0f3e1c2a-9b7d-4e1f-8a2b-000000000001";

describe("stringArray", () => {
  it("accepts a non-empty list of strings within the limit", () => {
    expect(stringArray(["a", "b"], 2)).toEqual(["a", "b"]);
  });

  it("refuses an empty list, an over-long list, a non-list and non-string items", () => {
    expect(stringArray([], 2)).toBeNull();
    expect(stringArray(["a", "b", "c"], 2)).toBeNull();
    expect(stringArray("a", 2)).toBeNull();
    expect(stringArray([1], 2)).toBeNull();
    expect(stringArray(undefined, 2)).toBeNull();
  });
});

describe("readJsonBody", () => {
  const post = (body: string) => new Request("http://localhost/api/x", { method: "POST", body });

  it("reads an object body", async () => {
    expect(await readJsonBody<{ ids: string[] }>(post('{"ids":["a"]}'))).toEqual({ ids: ["a"] });
  });

  it("answers null for a malformed body and for a body that is not an object", async () => {
    expect(await readJsonBody(post("{not json"))).toBeNull();
    expect(await readJsonBody(post("null"))).toBeNull();
    expect(await readJsonBody(post('"text"'))).toBeNull();
  });
});

describe("registerFiltersFromSearch", () => {
  it("reads every filter the register understands", () => {
    const filters = registerFiltersFromSearch(
      new URLSearchParams(`view=sent&status=accepted&kind=sale&from=2026-10-01&to=2026-10-09&locationId=${LOCATION}&q=%20۱۰۴۲%20`),
    );
    expect(filters).toMatchObject({
      view: "sent",
      status: "accepted",
      kind: "sale",
      from: "2026-10-01",
      to: "2026-10-09",
      locationId: LOCATION,
      q: "۱۰۴۲",
    });
  });

  it("defaults to the whole register when nothing is asked", () => {
    expect(registerFiltersFromSearch(new URLSearchParams(""))).toMatchObject({ view: "all", status: undefined, kind: undefined, from: undefined });
  });

  it("refuses anything outside the vocabulary rather than ignoring it", () => {
    const refuse = (query: string) => expect(() => registerFiltersFromSearch(new URLSearchParams(query))).toThrow(RangeError);
    refuse("view=everything");
    refuse("status=paid");
    refuse("kind=refund");
    refuse("from=2026/10/01");
    refuse("locationId=not-a-uuid");
    refuse(`q=${"x".repeat(101)}`);
  });
});

describe("taxErrorResponse", () => {
  it("returns a service refusal with its status, stable code and message", async () => {
    const response = taxErrorResponse(new TaxServiceError("not_accepted", 409, "فقط صورتحساب پذیرفته‌شده را می‌توان اصلاح کرد."));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_accepted", message: "فقط صورتحساب پذیرفته‌شده را می‌توان اصلاح کرد." });
  });

  it("returns a bad query as a 400 with the reason", async () => {
    const response = taxErrorResponse(new RangeError("نمای نامعتبر است."));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", message: "نمای نامعتبر است." });
  });

  it("does not dress an unknown failure up as a refusal; it propagates to the route's own handling", () => {
    expect(() => taxErrorResponse(new Error("database is down"))).toThrow("database is down");
  });
});
