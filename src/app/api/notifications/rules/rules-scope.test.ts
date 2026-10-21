import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { canReceiveNotification } from "@/lib/notification-authorization";
import { notificationPreferences, saveNotificationRule } from "@/lib/notifications-service";
import type { NotificationRuleInput } from "@/lib/notifications";
const branch = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/auth", () => ({
  requireMember: vi.fn(async () => ({
    session: { businessId: "business", sub: "staff", role: "cashier" },
  })),
  withTenantScope: (fn: unknown) => fn,
}));
vi.mock("@/lib/notification-authorization", () => ({ canReceiveNotification: vi.fn() }));
vi.mock("@/lib/notifications-service", () => ({
  notificationRuleLocations: vi.fn(async () => [
    { id: "11111111-1111-4111-8111-111111111111", name: "Own branch" },
  ]),
  notificationPreferences: vi.fn(async () => []),
  saveNotificationRule: vi.fn(),
}));
const request = (query = "", body?: unknown) =>
  new NextRequest(
    `https://example.test/api/notifications/rules${query}`,
    body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canReceiveNotification).mockImplementation(
    async (_business, _user, event) =>
      event.event_key === "order.voided" && event.location_id === branch,
  );
});
describe("rule authorization scope", () => {
  it("uses the selected accessible branch when filtering the catalogue", async () => {
    const response = await GET(request(`?locationId=${branch}`));
    expect(response.status).toBe(200);
    expect((await response.json()).events.map((event: { key: string }) => event.key)).toEqual([
      "order.voided",
    ]);
    expect(canReceiveNotification).toHaveBeenCalledWith(
      "business",
      "staff",
      { event_key: "order.voided", location_id: branch },
      true,
    );
    expect(notificationPreferences).toHaveBeenCalledWith("business", "staff", "cashier", branch);
  });
  it("authorizes a write at the named branch, not as a business-wide disclosure", async () => {
    const body: NotificationRuleInput = {
      eventKey: "order.voided",
      locationId: branch,
      enabled: true,
      channels: ["inapp"],
      minSeverity: "info",
      minAmountRial: null,
      quietFromMinutes: null,
      quietToMinutes: null,
    };
    vi.mocked(saveNotificationRule).mockResolvedValue({
      ok: true,
      rule: { ...body, id: "rule", userId: "staff" },
    });
    const response = await POST(request("", body));
    expect(response.status).toBe(200);
    expect(canReceiveNotification).toHaveBeenCalledWith(
      "business",
      "staff",
      { event_key: "order.voided", location_id: branch },
      true,
    );
    expect(saveNotificationRule).toHaveBeenCalledWith("business", "staff", body);
  });
  it("rejects inaccessible and malformed branch inputs before saving", async () => {
    expect((await GET(request("?locationId=22222222-2222-4222-8222-222222222222"))).status).toBe(
      400,
    );
    expect(
      (
        await POST(
          request("", {
            eventKey: "order.voided",
            locationId: "22222222-2222-4222-8222-222222222222",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(request("", { eventKey: "order.voided", locationId: "not-a-uuid" }))).status,
    ).toBe(400);
    expect(saveNotificationRule).not.toHaveBeenCalled();
  });
});
