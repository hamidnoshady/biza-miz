// @vitest-environment jsdom

/**
 * Issue #884 — rendered contract for the business-wide Android device
 * registry card (owner decision #1, ISSUE_884_PLAN.md).
 *
 * The API routes are permission-gated server-side already
 * (`requirePermission(PERMISSIONS.nativeDevicesManage)`); these tests prove
 * the screen agrees instead of offering controls that would come back 403 —
 * it must render nothing for a member who lacks the permission, and must
 * call the real revoke/reactivate routes (not the self-service ones) for one
 * who holds it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeDeviceManagementSettings } from "./native-device-management-settings";

interface Recorded {
  method: string;
  url: string;
}

const recorded: Recorded[] = [];
let devices: Record<string, unknown>[] = [];

function activeDevice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dev-1",
    userId: "user-1",
    userName: "سارا احمدی",
    appEnvironment: "production",
    appVersionName: "1.2.0",
    registeredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-05T00:00:00.000Z",
    revokedAt: null,
    reactivatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  recorded.length = 0;
  devices = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      recorded.push({ method, url });

      if (url === "/api/native-devices" && method === "GET") {
        return new Response(JSON.stringify({ devices }), { status: 200 });
      }
      if (url.match(/^\/api\/native-devices\/[^/]+$/) && method === "DELETE") {
        const id = url.split("/").pop();
        devices = devices.map((d) => (d.id === id ? { ...d, revokedAt: "2026-01-06T00:00:00.000Z" } : d));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.match(/^\/api\/native-devices\/[^/]+\/reactivate$/) && method === "POST") {
        const id = url.split("/")[3];
        devices = devices.map((d) => (d.id === id ? { ...d, revokedAt: null } : d));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NativeDeviceManagementSettings", () => {
  it("renders nothing, and never calls the network, for a member without the permission", () => {
    const { container } = render(<NativeDeviceManagementSettings isOwner={false} permissions={[]} />);
    expect(container.firstChild).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("renders for the owner even with no explicit permission list", async () => {
    devices = [activeDevice()];
    render(<NativeDeviceManagementSettings isOwner permissions={undefined} />);
    await waitFor(() => expect(recorded.some((r) => r.url === "/api/native-devices")).toBe(true));
    await screen.findByText("سارا احمدی");
  });

  it("renders for a non-owner member who was granted native_devices.manage", async () => {
    devices = [activeDevice()];
    render(
      <NativeDeviceManagementSettings isOwner={false} permissions={["native_devices.manage"]} />,
    );
    await screen.findByText("سارا احمدی");
  });

  it("revokes a listed device through the admin route, not the self-service one", async () => {
    devices = [activeDevice()];
    render(<NativeDeviceManagementSettings isOwner permissions={[]} />);
    await screen.findByText("سارا احمدی");

    fireEvent.click(screen.getByRole("button", { name: "لغو ثبت" }));

    await waitFor(() =>
      expect(recorded.some((r) => r.method === "DELETE" && r.url === "/api/native-devices/dev-1")).toBe(true),
    );
    // Reloads afterwards — the row now shows under the revoked history.
    await screen.findByText(/سابقهٔ نصب‌های لغوشده/);
  });

  it("reactivates a revoked device through the admin route", async () => {
    devices = [activeDevice({ revokedAt: "2026-01-06T00:00:00.000Z" })];
    render(<NativeDeviceManagementSettings isOwner permissions={[]} />);

    fireEvent.click(await screen.findByText(/سابقهٔ نصب‌های لغوشده/));
    fireEvent.click(await screen.findByRole("button", { name: "فعال‌سازی دوباره" }));

    await waitFor(() =>
      expect(
        recorded.some((r) => r.method === "POST" && r.url === "/api/native-devices/dev-1/reactivate"),
      ).toBe(true),
    );
  });

  it("shows an empty state when the business has no registered installations", async () => {
    devices = [];
    render(<NativeDeviceManagementSettings isOwner permissions={[]} />);
    await screen.findByText(/هیچ نصب فعالی/);
  });
});
