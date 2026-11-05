import { describe, expect, it } from "vitest";
import { encodeWpQueueCursor, parseWpQueueCursor } from "./wp-queue-cursor";

const ROW_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const CREATED_AT = "2026-11-04 17:22:11.432+00";

describe("#1077 queue keyset cursor", () => {
  it("round-trips a Postgres timestamp and row id", () => {
    const token = encodeWpQueueCursor({ createdAt: CREATED_AT, id: ROW_ID });
    expect(token).not.toContain(" "); // base64url, safe in a query string
    expect(parseWpQueueCursor(token)).toEqual({ createdAt: CREATED_AT, id: ROW_ID });
  });

  it("round-trips an ISO timestamp with a timezone offset", () => {
    const createdAt = "2026-11-04T17:22:11.432Z";
    expect(parseWpQueueCursor(encodeWpQueueCursor({ createdAt, id: ROW_ID }))).toEqual({ createdAt, id: ROW_ID });
  });

  it("refuses anything it did not mint", () => {
    expect(parseWpQueueCursor(undefined)).toBeNull();
    expect(parseWpQueueCursor("")).toBeNull();
    expect(parseWpQueueCursor("   ")).toBeNull();
    expect(parseWpQueueCursor("not-base64-$$$")).toBeNull();
    expect(parseWpQueueCursor(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
    expect(parseWpQueueCursor(Buffer.from('"a string"', "utf8").toString("base64url"))).toBeNull();
    expect(parseWpQueueCursor("x".repeat(400))).toBeNull();
  });

  it("refuses a token whose parts are the wrong shape", () => {
    const token = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    expect(parseWpQueueCursor(token({ c: CREATED_AT }))).toBeNull();
    expect(parseWpQueueCursor(token({ i: ROW_ID }))).toBeNull();
    expect(parseWpQueueCursor(token({ c: 42, i: ROW_ID }))).toBeNull();
    expect(parseWpQueueCursor(token({ c: CREATED_AT, i: 42 }))).toBeNull();
    // A uuid-shaped check, not merely "some string": the SQL casts this to uuid.
    expect(parseWpQueueCursor(token({ c: CREATED_AT, i: "row-7" }))).toBeNull();
    // Postgres would reject these timestamps, so they never reach the query.
    expect(parseWpQueueCursor(token({ c: "yesterday", i: ROW_ID }))).toBeNull();
    expect(parseWpQueueCursor(token({ c: "2026-13-45 99:99:99", i: ROW_ID }))).toBeNull();
    expect(parseWpQueueCursor(token({ c: `${CREATED_AT}'. OR 1=1 --`, i: ROW_ID }))).toBeNull();
  });
});
