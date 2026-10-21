import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as removeDevice } from "./devices/[id]/route";
import { DELETE as removeRule } from "./rules/[id]/route";
import { GET as inbox, PATCH as read } from "./inbox/route";
import { POST as register } from "./devices/route";
import { POST as testPush } from "./test/route";
import { notificationApiAllowed } from "@/lib/notification-api";
import {
  listNotificationInbox,
  markNotificationsRead,
  registerNotificationDevice,
  removeNotificationDevice,
  deleteNotificationRule,
  sendTestNotification,
} from "@/lib/notifications-service";
const session = { businessId: "b", sub: "u", employeeSessionId: "s" };
vi.mock("@/lib/auth", () => ({
  requireMember: vi.fn(async () => ({ session })),
  withTenantScope: (fn: unknown) => fn,
}));
vi.mock("@/lib/notification-api", async (original) => ({
  ...(await original<typeof import("@/lib/notification-api")>()),
  notificationApiAllowed: vi.fn(),
}));
vi.mock("@/lib/notifications-service", () => ({
  listNotificationInbox: vi.fn(),
  markNotificationsRead: vi.fn(),
  registerNotificationDevice: vi.fn(),
  removeNotificationDevice: vi.fn(),
  deleteNotificationRule: vi.fn(),
  sendTestNotification: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notificationApiAllowed).mockResolvedValue(true);
});
const request = (url: string, body?: string) =>
  new NextRequest(
    `https://example.test/api/notifications/${url}`,
    body === undefined ? {} : { method: "POST", body },
  );
describe("notification input and abuse boundaries", () => {
  it.each(["abc", "1", "' OR true --", "not-a-uuid"])(
    "rejects malformed route identifier %s without DB calls",
    async (id) => {
      expect(
        (await removeDevice(request("devices/x"), { params: Promise.resolve({ id }) })).status,
      ).toBe(400);
      expect(
        (await removeRule(request("rules/x"), { params: Promise.resolve({ id }) })).status,
      ).toBe(400);
      expect(removeNotificationDevice).not.toHaveBeenCalled();
      expect(deleteNotificationRule).not.toHaveBeenCalled();
    },
  );
  it.each(["0", "1.5", "NaN", "201", "-1"])("rejects invalid inbox limit %s", async (limit) => {
    expect((await inbox(request(`inbox?limit=${limit}`))).status).toBe(400);
    expect(listNotificationInbox).not.toHaveBeenCalled();
  });
  it.each(["{", "null", "[]", '{"id":"bad"}', '{"id":7}'])(
    "never interprets malformed read body %s as mark-all",
    async (body) => {
      expect((await read(request("inbox", body))).status).toBe(400);
      expect(markNotificationsRead).not.toHaveBeenCalled();
    },
  );
  it.each(["null", "[]", '{"label":7}', '{"endpoint":{}}'])(
    "validates registration body %s",
    async (body) => {
      expect((await register(request("devices", body))).status).toBe(400);
      expect(registerNotificationDevice).not.toHaveBeenCalled();
    },
  );
  it("rejects test/register abuse before network or registration", async () => {
    vi.mocked(notificationApiAllowed).mockResolvedValue(false);
    expect((await register(request("devices", "{}"))).status).toBe(429);
    expect((await testPush()).status).toBe(429);
    expect(registerNotificationDevice).not.toHaveBeenCalled();
    expect(sendTestNotification).not.toHaveBeenCalled();
  });
  it("passes only authenticated tenant/user to read and mark-one", async () => {
    vi.mocked(listNotificationInbox).mockResolvedValue({ entries: [], unread: 0 });
    expect((await inbox(request("inbox?limit=10"))).status).toBe(200);
    expect(listNotificationInbox).toHaveBeenCalledWith("b", "u", 10);
    const id = "12345678-1234-1234-1234-123456789012";
    vi.mocked(markNotificationsRead).mockResolvedValue(1);
    expect(
      (await read(request("inbox", JSON.stringify({ id, businessId: "other", userId: "other" }))))
        .status,
    ).toBe(200);
    expect(markNotificationsRead).toHaveBeenCalledWith("b", "u", id);
  });
});
