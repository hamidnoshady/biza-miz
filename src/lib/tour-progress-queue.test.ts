import { describe, expect, it } from "vitest";
import {
  enqueueTourEvent,
  flushTourQueue,
  readTourQueue,
  TOUR_QUEUE_KEY,
  type QueueStorage,
} from "./tour-progress-queue";

function memoryStorage(): QueueStorage & { value: string | null } {
  const store = {
    value: null as string | null,
    getItem(key: string) {
      return key === TOUR_QUEUE_KEY ? store.value : null;
    },
    setItem(key: string, value: string) {
      if (key === TOUR_QUEUE_KEY) store.value = value;
    },
    removeItem(key: string) {
      if (key === TOUR_QUEUE_KEY) store.value = null;
    },
  };
  return store;
}

describe("the offline tour progress queue", () => {
  it("stores no business payload — only ids, an event and a member-scoped key", () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "crm.directory.first-customer", "step_seen", "register");
    const raw = storage.value ?? "";
    expect(raw).toContain("crm.directory.first-customer");
    expect(raw).toContain("viewer-a");
    expect(raw).not.toMatch(/customerName|amount|phone|email/i);
  });

  it("deduplicates the same event and keeps insertion order", () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "start");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "one");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "one");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "two");
    expect(readTourQueue(storage).map((event) => event.key)).toEqual([
      "t|start|",
      "t|step_seen|one",
      "t|step_seen|two",
    ]);
  });

  it("drops events before a deliberate reset", () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "start");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "one");
    enqueueTourEvent(storage, "viewer-a", "t", "reset");
    expect(readTourQueue(storage)).toEqual([]);
  });

  it("delivers in order and stops on a network failure without losing the rest", async () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t1", "start");
    enqueueTourEvent(storage, "viewer-a", "t1", "step_seen", "one");
    enqueueTourEvent(storage, "viewer-a", "t2", "start");

    const seen: string[] = [];
    const result = await flushTourQueue(storage, "viewer-a", async (entry) => {
      seen.push(entry.key);
      return entry.tourId === "t2" ? "retry" : "ok";
    });
    expect(seen).toEqual(["t1|start|", "t1|step_seen|one", "t2|start|"]);
    expect(result).toMatchObject({ delivered: 2, remaining: 1, stopped: true });
  });

  it("retrying after a failure delivers each event exactly once", async () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "start");
    enqueueTourEvent(storage, "viewer-a", "t", "complete");

    await flushTourQueue(storage, "viewer-a", async () => "retry");
    const delivered: string[] = [];
    const result = await flushTourQueue(storage, "viewer-a", async (entry) => {
      delivered.push(entry.key);
      return "ok";
    });
    expect(delivered).toEqual(["t|start|", "t|complete|"]);
    expect(result).toMatchObject({ delivered: 2, remaining: 0 });
  });

  it("never delivers one member's queue for another viewer", async () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "one");
    const delivered: string[] = [];
    const result = await flushTourQueue(storage, "viewer-b", async (entry) => {
      delivered.push(entry.key);
      return "ok";
    });
    expect(delivered).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it("clears the queue when the session is no longer valid", async () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "start");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "one");
    const result = await flushTourQueue(storage, "viewer-a", async () => "auth");
    expect(result.stopped).toBe(true);
    expect(readTourQueue(storage)).toEqual([]);
  });

  it("drops an event the server will never accept but keeps delivering", async () => {
    const storage = memoryStorage();
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "gone");
    enqueueTourEvent(storage, "viewer-a", "t", "step_seen", "real");
    const result = await flushTourQueue(storage, "viewer-a", async (entry) =>
      entry.stepId === "gone" ? "permanent" : "ok",
    );
    expect(result).toMatchObject({ delivered: 1, dropped: 1, remaining: 0 });
  });
});
