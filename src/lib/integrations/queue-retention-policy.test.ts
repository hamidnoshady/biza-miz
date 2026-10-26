import { describe, expect, it } from "vitest";
import {
  QUEUE_DEAD_RETENTION_DAYS,
  QUEUE_DONE_RETENTION_DAYS,
  retentionCutoffs,
} from "./queue-retention-policy";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("queue retention policy (issue #1077)", () => {
  it("keeps finished rows 90 days and unresolved failures 180 days", () => {
    expect(QUEUE_DONE_RETENTION_DAYS).toBe(90);
    expect(QUEUE_DEAD_RETENTION_DAYS).toBe(180);
  });

  it("derives both cutoffs from the same instant", () => {
    const { doneBefore, deadBefore } = retentionCutoffs(NOW);
    expect(NOW.getTime() - doneBefore.getTime()).toBe(90 * DAY);
    expect(NOW.getTime() - deadBefore.getTime()).toBe(180 * DAY);
  });

  it("never keeps failures for less time than finished work", () => {
    const { doneBefore, deadBefore } = retentionCutoffs(NOW);
    expect(deadBefore.getTime()).toBeLessThan(doneBefore.getTime());
  });
});
