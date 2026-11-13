import { describe, expect, it } from "vitest";
import {
  readReservation,
  reservationInstant,
  reservationWindow,
} from "./agency-reservation";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  taskId: id,
  workerId: id,
  requestId: id,
  startAt: "2026-11-01T09:00Z",
  endAt: "2026-11-01T10:00Z",
  note: " planned ",
  status: "reserved",
  supersedesId: null,
};
describe("explicit planned intervals", () => {
  it("canonicalizes equivalent offsets without using browser-local timezone", () => {
    expect(reservationInstant("2026-11-01T12:30+03:30")).toBe(
      "2026-11-01T09:00:00.000Z",
    );
    expect(reservationInstant("2026-11-01T04:00-05:00")).toBe(
      "2026-11-01T09:00:00.000Z",
    );
    expect(readReservation(input)).toEqual({
      ...input,
      startAt: "2026-11-01T09:00:00.000Z",
      endAt: "2026-11-01T10:00:00.000Z",
      note: "planned",
    });
  });
  for (const value of [
    "2026-11-01T09:00",
    "2026-02-29T09:00Z",
    "2026-11-01T24:00Z",
    "2026-11-01T09:60Z",
    "2026-11-01T09:00:01Z",
    "2026-11-01T09:00:00.001Z",
    "2026-11-01T09:00+14:30",
    "2026-11-01T09:00+15:00",
    "2026-11-01T09:00+02:60",
    "bad",
    "0001-01-01T00:00+14:00",
  ])
    it(`rejects invalid/naive instant ${value}`, () =>
      expect(() => reservationInstant(value)).toThrow("invalid_reservation"));
  const cases: Record<string, unknown>[] = [
    { taskId: "bad" },
    { workerId: null },
    { requestId: undefined },
    { status: "approved" },
    { status: ["reserved"] },
    { status: null },
    { status: "cancelled" },
    { supersedesId: "bad" },
    { note: "" },
    { note: "x".repeat(1001) },
    { endAt: input.startAt },
    { endAt: "2026-11-01T08:00Z" },
    { endAt: "2026-11-02T09:01Z" },
  ];
  for (const extra of cases)
    it(`rejects invalid reservation ${JSON.stringify(extra)}`, () =>
      expect(() => readReservation({ ...input, ...extra })).toThrow(
        "invalid_reservation",
      ));
  it("accepts a full elapsed day or explicit cancellation lineage without approving actual time", () => {
    expect(
      readReservation({ ...input, endAt: "2026-11-02T09:00Z" }).endAt,
    ).toBe("2026-11-02T09:00:00.000Z");
    expect(
      readReservation({ ...input, status: "cancelled", supersedesId: id })
        .status,
    ).toBe("cancelled");
    expect(
      readReservation({ ...input, createdBy: "forged", actualMinutes: 60 }),
    ).not.toHaveProperty("createdBy");
  });
  it("bounds windows and safe paging without silently clamping offsets", () => {
    expect(
      reservationWindow(
        new URLSearchParams({
          from: "2026-01-01",
          to: "2026-04-03",
          offset: "100",
        }),
      ),
    ).toEqual({ from: "2026-01-01", to: "2026-04-03", offset: 100 });
    for (const query of [
      "from=2026-01-01&to=2026-04-04",
      "from=bad&to=2026-11-01",
      "from=2026-11-02&to=2026-11-01",
      "from=2026-11-01&to=2026-11-01&offset=-1",
      "from=2026-11-01&to=2026-11-01&offset=9007199254740992",
    ])
      expect(() => reservationWindow(new URLSearchParams(query))).toThrow();
  });
});
