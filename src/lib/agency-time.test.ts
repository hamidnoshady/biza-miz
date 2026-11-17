import { describe, expect, it } from "vitest";
import { readAgencyTime } from "./agency-time";
const input = {
  taskId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  workDate: "2026-10-01",
  minutes: 60,
  note: " measured ",
  supersedesId: null,
};
describe("actual time declaration", () => {
  it("accepts explicit integral minutes and trims a required explanation", () =>
    expect(readAgencyTime(input)).toEqual({ ...input, note: "measured" }));
  it("accepts zero only as an explicit correction/void", () => {
    expect(() => readAgencyTime({ ...input, minutes: 0 })).toThrow();
    expect(
      readAgencyTime({ ...input, minutes: 0, supersedesId: input.taskId })
        .minutes,
    ).toBe(0);
  });
  const invalid: Record<string, unknown>[] = [
    { minutes: -1 },
    { minutes: 1441 },
    { minutes: 1.5 },
    { minutes: "60" },
    { minutes: NaN },
    { minutes: null },
    { minutes: undefined },
    { note: " " },
    { note: "a".repeat(1001) },
    { workDate: "2026-02-29" },
    { taskId: "bad" },
    { requestId: "" },
    { supersedesId: "bad" },
  ];
  for (const extra of invalid)
    it(`refuses invalid field ${JSON.stringify(extra)}`, () =>
      expect(() => readAgencyTime({ ...input, ...extra })).toThrow(
        "invalid_time",
      ));
  it("ignores actor and approval claims from the request", () =>
    expect(
      readAgencyTime({ ...input, createdBy: "fake", approved: true }),
    ).toEqual({ ...input, note: "measured" }));
});
