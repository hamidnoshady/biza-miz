/**
 * The enqueue helper is called from request handlers *and* background ticks,
 * including ticks that hold a platform bypass (or no scope) when the
 * notification is produced. `notification_events` is FORCE RLS, so the write
 * has to carry its own business scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  scopes: [] as string[],
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withTenant: (businessId: string, fn: () => Promise<unknown>) => {
    mocks.scopes.push(businessId);
    return fn();
  },
}));

import { recordNotification } from "./notification-events";

const input = {
  businessId: "biz-1",
  locationId: null,
  eventKey: "backup.drill_failed" as const,
  severity: "critical" as const,
  title: "آزمایش بازیابی پشتیبان ناموفق بود",
  dedupeKey: "backup.drill_failed:biz-1:2026-11-22",
};

beforeEach(() => {
  mocks.query.mockReset();
  mocks.scopes.length = 0;
});

describe("recordNotification", () => {
  it("enqueues inside the business scope the notification names", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1 });

    await expect(recordNotification(input)).resolves.toBe(true);

    expect(mocks.scopes).toEqual(["biz-1"]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO notification_events/);
    expect(params.slice(0, 3)).toEqual(["biz-1", null, "backup.drill_failed"]);
  });

  it("still swallows a rejected write, because a notification must never fail the operation", async () => {
    mocks.query.mockRejectedValue(
      Object.assign(new Error('new row violates row-level security policy for table "notification_events"'), {
        code: "42501",
      }),
    );

    await expect(recordNotification(input)).resolves.toBe(false);
  });
});
