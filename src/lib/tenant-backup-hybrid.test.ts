import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_FRESH_MS,
  QUEUE_BASE_BACKOFF_MS,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_BACKOFF_MS,
  connectivityFromHeartbeat,
  fenceDecision,
  planQueueEntry,
  queueBackoffMs,
  type QueueEntry,
} from "./tenant-backup-hybrid";

const now = new Date("2026-10-28T12:00:00.000Z");

function entry(patch: Partial<QueueEntry> = {}): QueueEntry {
  return {
    artifactName: "biz-20261028-090000-local.dump.enc",
    generation: 4,
    state: "queued",
    attempts: 0,
    nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
    ...patch,
  };
}

describe("queueBackoffMs", () => {
  it("doubles from one minute and caps at six hours", () => {
    expect(queueBackoffMs(0)).toBe(QUEUE_BASE_BACKOFF_MS);
    expect(queueBackoffMs(1)).toBe(2 * QUEUE_BASE_BACKOFF_MS);
    expect(queueBackoffMs(3)).toBe(8 * QUEUE_BASE_BACKOFF_MS);
    expect(queueBackoffMs(40)).toBe(QUEUE_MAX_BACKOFF_MS);
    expect(queueBackoffMs(-5)).toBe(QUEUE_BASE_BACKOFF_MS);
  });
});

describe("planQueueEntry", () => {
  it("uploads a due entry", () => {
    expect(planQueueEntry(entry(), now)).toEqual({ action: "upload" });
  });

  it("waits until the backoff window opens", () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    expect(planQueueEntry(entry({ nextAttemptAt: future }), now)).toEqual({ action: "wait", until: future });
  });

  it("dead-letters once the attempt budget is spent", () => {
    expect(planQueueEntry(entry({ attempts: QUEUE_MAX_ATTEMPTS }), now)).toEqual({
      action: "dead",
      reason: "too_many_attempts",
    });
  });

  it.each([
    ["done", { action: "skip", reason: "already_done" }],
    ["superseded", { action: "skip", reason: "superseded" }],
    ["dead", { action: "dead", reason: "too_many_attempts" }],
  ] as const)("does nothing for a %s entry", (state, expected) => {
    expect(planQueueEntry(entry({ state, attempts: 0 }), now)).toEqual(expected);
  });
});

describe("fenceDecision", () => {
  it("allows an artifact from the accepted generation or newer", () => {
    expect(fenceDecision({ generation: 5, acceptedGeneration: 5 })).toEqual({ ok: true });
    expect(fenceDecision({ generation: 6, acceptedGeneration: 5 })).toEqual({ ok: true });
  });

  it("refuses an artifact from a re-imaged or restored-back install", () => {
    expect(fenceDecision({ generation: 3, acceptedGeneration: 5 })).toEqual({
      ok: false,
      reason: "stale_generation",
    });
  });

  it("refuses a generation that is not a real counter", () => {
    expect(fenceDecision({ generation: -1, acceptedGeneration: 0 })).toEqual({
      ok: false,
      reason: "generation_invalid",
    });
    expect(fenceDecision({ generation: 1.5, acceptedGeneration: 0 })).toEqual({
      ok: false,
      reason: "generation_invalid",
    });
  });
});

describe("connectivityFromHeartbeat", () => {
  it("reports online only inside the freshness window", () => {
    expect(connectivityFromHeartbeat(now.toISOString(), now)).toBe("online");
    const edge = new Date(now.getTime() - HEARTBEAT_FRESH_MS).toISOString();
    expect(connectivityFromHeartbeat(edge, now)).toBe("online");
    const stale = new Date(now.getTime() - HEARTBEAT_FRESH_MS - 1000).toISOString();
    expect(connectivityFromHeartbeat(stale, now)).toBe("offline");
  });

  it("says unknown when no heartbeat ever arrived — never a cheerful default", () => {
    expect(connectivityFromHeartbeat(null, now)).toBe("unknown");
    expect(connectivityFromHeartbeat("not a date", now)).toBe("unknown");
  });
});
