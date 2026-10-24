import { describe, expect, it } from "vitest";
import { validateDesktopUpdateCommandResult } from "./desktop-update-command";

const valid = {
  id: "11111111-1111-4111-8111-111111111111",
  sequence: 7,
  status: "verified",
  occurredAt: "2026-10-21T08:00:00.000Z",
  code: null,
};

describe("desktop update command receipts", () => {
  it("accepts the bounded, monotonic receipt shape", () => {
    expect(validateDesktopUpdateCommandResult(valid)).toEqual(valid);
  });

  it.each([
    { id: "foreign" }, { sequence: 0 }, { sequence: 1.5 }, { status: "queued" },
    { occurredAt: "later" }, { code: "x".repeat(121) },
  ])("rejects malformed or server-only state: %j", (patch) => {
    expect(validateDesktopUpdateCommandResult({ ...valid, ...patch })).toBeNull();
  });
});
