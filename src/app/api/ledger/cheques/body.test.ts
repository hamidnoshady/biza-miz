import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { MalformedBodyError, readJsonObjectBody } from "./body";

function requestWith(body: string | null): NextRequest {
  return new Request("https://example.test/api/ledger/cheques/x/clear", {
    method: "POST",
    ...(body === null ? {} : { body }),
  }) as unknown as NextRequest;
}

describe("readJsonObjectBody", () => {
  it("reads a body with no payload as an empty object — most cheque actions need none", async () => {
    await expect(readJsonObjectBody(requestWith(null))).resolves.toEqual({});
    await expect(readJsonObjectBody(requestWith(""))).resolves.toEqual({});
    await expect(readJsonObjectBody(requestWith("   \n"))).resolves.toEqual({});
    await expect(readJsonObjectBody(requestWith("{}"))).resolves.toEqual({});
  });

  it("keeps the fields of a real payload", async () => {
    await expect(readJsonObjectBody(requestWith('{"occurredOn":"2026-03-10"}'))).resolves.toEqual({
      occurredOn: "2026-03-10",
    });
  });

  it("refuses malformed JSON instead of silently running the action with defaults", async () => {
    for (const body of ['{"occurredOn":', "{oops}", "not json at all"]) {
      await expect(readJsonObjectBody(requestWith(body))).rejects.toBeInstanceOf(MalformedBodyError);
    }
  });

  it("refuses a JSON value that is not an object", async () => {
    for (const body of ["[]", '"deposit"', "7", "null"]) {
      await expect(readJsonObjectBody(requestWith(body))).rejects.toBeInstanceOf(MalformedBodyError);
    }
  });
});
