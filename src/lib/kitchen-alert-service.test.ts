import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ query: vi.fn() }));
const notificationMocks = vi.hoisted(() => ({ recordNotification: vi.fn() }));

vi.mock("./db", () => dbMocks);
vi.mock("./notification-events", () => notificationMocks);

import {
  loadKitchenAlertThresholds,
  recordKitchenItemsAdded,
  recordKitchenTicketCreated,
  scanKitchenTicketAging,
} from "./kitchen-alert-service";

beforeEach(() => {
  vi.clearAllMocks();
  notificationMocks.recordNotification.mockResolvedValue(true);
});

describe("kitchen notification producers", () => {
  it("names the order for a new ticket so retries cannot notify twice", async () => {
    await recordKitchenTicketCreated({
      businessId: "business-1",
      locationId: "location-1",
      orderId: "order-1",
      orderNumber: 12,
      items: [
        { name: "لاته", quantity: 2 },
        { name: "کیک", quantity: 1 },
      ],
      itemIds: ["line-1", "line-2"],
    });

    expect(notificationMocks.recordNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        locationId: "location-1",
        eventKey: "kitchen.ticket_created",
        url: "/accounting/kitchen",
        dedupeKey: "kitchen.ticket_created:order-1",
        payload: expect.objectContaining({ orderId: "order-1", orderNumber: 12 }),
      }),
    );
  });

  it("dedupes the same added round but allows a genuinely new line set", async () => {
    const base = {
      businessId: "business-1",
      locationId: "location-1",
      orderId: "order-1",
      orderNumber: 12,
      items: [{ name: "لاته", quantity: 1 }],
    };
    await recordKitchenItemsAdded({ ...base, itemIds: ["line-b", "line-a"] });
    await recordKitchenItemsAdded({ ...base, itemIds: ["line-a", "line-b"] });
    await recordKitchenItemsAdded({ ...base, itemIds: ["line-c"] });

    const first = notificationMocks.recordNotification.mock.calls[0][0].dedupeKey;
    const second = notificationMocks.recordNotification.mock.calls[1][0].dedupeKey;
    const third = notificationMocks.recordNotification.mock.calls[2][0].dedupeKey;
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first.startsWith("kitchen.items_added:order-1:")).toBe(true);
  });
});

describe("branch threshold layers", () => {
  it("prefers a branch override to a business default", async () => {
    dbMocks.query.mockResolvedValue({
      rows: [
        { location_id: null, value: { overdueMinutes: 20, approachingMinutes: 10 } },
        { location_id: "location-1", value: { overdueMinutes: 15, approachingMinutes: 8 } },
      ],
    });

    await expect(loadKitchenAlertThresholds("business-1", "location-1")).resolves.toEqual({
      defaults: { overdueMinutes: 20, approachingMinutes: 10 },
      overrides: { overdueMinutes: 15, approachingMinutes: 8 },
      effective: { overdueMinutes: 15, approachingMinutes: 8 },
    });
  });
});

describe("kitchen ticket aging scan", () => {
  it("uses the persisted send time and stable stage/line set for the dedupe key", async () => {
    const sentAt = new Date(Date.now() - 12 * 60_000).toISOString();
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM settings")) {
        return {
          rows: [{ location_id: "location-1", value: { overdueMinutes: 10, approachingMinutes: 5 } }],
        };
      }
      return {
        rows: [
          {
            location_id: "location-1",
            order_id: "order-1",
            order_number: "7",
            sent_at: sentAt,
            item_ids: ["line-1", "line-2"],
          },
        ],
      };
    });

    await expect(scanKitchenTicketAging("business-1")).resolves.toBe(1);
    const firstCall = notificationMocks.recordNotification.mock.calls[0][0];
    expect(firstCall).toMatchObject({
      eventKey: "kitchen.ticket_aged",
      severity: "important",
      title: expect.stringContaining("۷"),
      payload: expect.objectContaining({
        orderId: "order-1",
        stage: "overdue",
        overdueMinutes: 10,
        approachingMinutes: 5,
      }),
    });

    await scanKitchenTicketAging("business-1");
    const secondCall = notificationMocks.recordNotification.mock.calls[1][0];
    expect(secondCall.dedupeKey).toBe(firstCall.dedupeKey);
  });

  it("queues only the configured stage that has actually been reached", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM settings")) {
        return {
          rows: [{ location_id: "location-1", value: { overdueMinutes: 10, approachingMinutes: 5 } }],
        };
      }
      return {
        rows: [
          {
            location_id: "location-1",
            order_id: "order-young",
            order_number: "8",
            sent_at: new Date(Date.now() - 2 * 60_000).toISOString(),
            item_ids: ["line-8"],
          },
        ],
      };
    });

    await expect(scanKitchenTicketAging("business-1")).resolves.toBe(0);
    expect(notificationMocks.recordNotification).not.toHaveBeenCalled();
  });
});
