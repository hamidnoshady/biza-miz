import { describe, expect, it } from "vitest";
import { attemptDue, backoffDelayMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, nextAttemptAt } from "./sync-backoff";

const noJitter = () => 0.5;

describe("sync backoff", () => {
  it("waits nothing before the first failure", () => {
    expect(backoffDelayMs(0, noJitter)).toBe(0);
    expect(nextAttemptAt(0, new Date(0), noJitter)).toBeNull();
  });

  it("doubles per consecutive failure and stops at the cap", () => {
    expect(backoffDelayMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(50, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it("spreads retries by at most ±20%", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(BACKOFF_BASE_MS * 0.8);
    expect(backoffDelayMs(1, () => 1)).toBe(BACKOFF_BASE_MS * 1.2);
  });

  it("says when an attempt is due", () => {
    const now = new Date("2026-09-28T10:00:00Z");
    expect(attemptDue(null, now)).toBe(true);
    expect(attemptDue("2026-09-28T09:59:00Z", now)).toBe(true);
    expect(attemptDue("2026-09-28T10:01:00Z", now)).toBe(false);
    expect(attemptDue("not a date", now)).toBe(true);
    expect(nextAttemptAt(1, now, noJitter)).toBe("2026-09-28T10:00:30.000Z");
  });
});
