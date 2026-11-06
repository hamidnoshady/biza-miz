import { describe, expect, it } from "vitest";
import {
  LOCAL_QUEUE_PAGE_MAX,
  normaliseLocalQueuePageRequest,
  parseLocalQueuePageAnswer,
  parseLocalQueuePageRequest,
  sanitizeLocalQueuePageAnswer,
} from "./local-queue-page";

describe("#1076 plugin-local queue page protocol", () => {
  it("normalises an operator request and bounds it to the plugin's own ceiling", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    expect(normaliseLocalQueuePageRequest(0, 10, now)).toEqual({ after: 0, limit: 10, requestedAt: now.toISOString() });
    expect(normaliseLocalQueuePageRequest("42", "500", now)?.limit).toBe(LOCAL_QUEUE_PAGE_MAX);
    // No cursor means "from the beginning"; no limit means the default page.
    expect(normaliseLocalQueuePageRequest(undefined, undefined, now)).toEqual({ after: 0, limit: 10, requestedAt: now.toISOString() });
  });

  it("refuses requests it cannot express", () => {
    expect(normaliseLocalQueuePageRequest(-1, 10)).toBeNull();
    expect(normaliseLocalQueuePageRequest(0, 0)).toBeNull();
    expect(normaliseLocalQueuePageRequest(0, "many")).toBeNull();
    expect(normaliseLocalQueuePageRequest(1.5, 10)).toBeNull();
    expect(normaliseLocalQueuePageRequest(1e12, 10)).toBeNull();
  });

  it("reads back a stored request, dropping anything malformed", () => {
    expect(parseLocalQueuePageRequest({ after: 7, limit: 10, requestedAt: "2026-11-05T10:00:00.000Z" })).toEqual({
      after: 7,
      limit: 10,
      requestedAt: "2026-11-05T10:00:00.000Z",
    });
    expect(parseLocalQueuePageRequest(null)).toBeNull();
    expect(parseLocalQueuePageRequest({})).toBeNull();
    expect(parseLocalQueuePageRequest({ after: 7, limit: 10, requestedAt: "yesterday" })).toBeNull();
    expect(parseLocalQueuePageRequest({ after: 7, limit: 0, requestedAt: "2026-11-05T10:00:00.000Z" })).toBeNull();
  });

  it("bounds and reduces a plugin answer to metadata only", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      topic: `product.updated.${index}`,
      remoteId: String(index),
      status: index % 2 === 0 ? "failed" : "pending",
      attempts: index,
      lastError: index === 0 ? "timeout" : null,
      createdAt: "2026-11-05T09:00:00+00:00",
      // A payload must never survive into the mailbox.
      payload: { consumer_secret: "cs_should_never_show" },
    }));
    const answer = sanitizeLocalQueuePageAnswer({ after: 0, limit: 10, rows, next: 40 });
    expect(answer).not.toBeNull();
    expect(answer!.rows).toHaveLength(LOCAL_QUEUE_PAGE_MAX);
    expect(JSON.stringify(answer)).not.toContain("cs_should_never_show");
    expect(Object.keys(answer!.rows[0]).sort()).toEqual([
      "attempts",
      "createdAt",
      "lastError",
      "remoteId",
      "status",
      "topic",
    ]);
  });

  it("drops a row with no topic instead of inventing one", () => {
    const answer = sanitizeLocalQueuePageAnswer({
      after: 0,
      limit: 10,
      rows: [{ topic: "" }, { topic: "order.updated", remoteId: "12", status: "weird", attempts: "3" }],
    });
    expect(answer!.rows).toHaveLength(1);
    expect(answer!.rows[0]).toMatchObject({ topic: "order.updated", status: "pending", attempts: 3 });
  });

  it("refuses an answer with no cursor, no rows array, or a backwards next", () => {
    expect(sanitizeLocalQueuePageAnswer(null)).toBeNull();
    expect(sanitizeLocalQueuePageAnswer({ after: 0, limit: 10 })).toBeNull();
    expect(sanitizeLocalQueuePageAnswer({ limit: 10, rows: [] })).toBeNull();
    // `next` behind `after` would make a screen ask for the same page forever.
    expect(sanitizeLocalQueuePageAnswer({ after: 50, limit: 10, rows: [], next: 40 })!.next).toBeNull();
    expect(sanitizeLocalQueuePageAnswer({ after: 0, limit: 10, rows: [], next: 10 })!.next).toBe(10);
  });

  it("round-trips a stored answer through the reader", () => {
    const stored = { after: 10, limit: 10, rows: [], next: null, answeredAt: "2026-11-05T10:05:00.000Z" };
    expect(parseLocalQueuePageAnswer(stored)).toEqual(stored);
    expect(parseLocalQueuePageAnswer({ ...stored, answeredAt: "not a date" })!.answeredAt).not.toBe("not a date");
  });
});
