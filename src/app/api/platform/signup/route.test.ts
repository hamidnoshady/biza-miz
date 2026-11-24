import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * Issue #1388 — the console's registration endpoint.
 *
 * Pins the two server-side boundaries the page must never be trusted for:
 * `signup.read` on GET, `signup.manage` on PUT, and an audit row carrying the
 * old and new values (never a secret) on every successful write.
 */
const mocks = vi.hoisted(() => ({
  requirePlatformCapability: vi.fn(),
  platformAudit: vi.fn(),
  readSignupControls: vi.fn(),
  saveSignupControls: vi.fn(),
  getSignupFunnel: vi.fn(),
  getAuthSmsHealth: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (handler: unknown) => handler,
  requirePlatformCapability: mocks.requirePlatformCapability,
  platformAudit: mocks.platformAudit,
}));

vi.mock("@/lib/iam/signup-controls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iam/signup-controls")>();
  return {
    ...actual,
    readSignupControls: mocks.readSignupControls,
    saveSignupControls: mocks.saveSignupControls,
  };
});

vi.mock("@/lib/iam/signup-events", () => ({
  getSignupFunnel: mocks.getSignupFunnel,
  getAuthSmsHealth: mocks.getAuthSmsHealth,
}));

import { GET, PUT } from "./route";

const admin = { padmin: "22222222-2222-4222-8222-222222222222" };
const controls = {
  publicSignupEnabled: true,
  maintenanceMode: false,
  maintenanceMessage: null,
  updatedAt: "2026-11-24T10:00:00.000Z",
  updatedBy: admin.padmin,
  updatedByName: "مدیر ارشد",
};

function put(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/platform/signup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSignupControls.mockResolvedValue({ controls: null, readable: true });
  mocks.saveSignupControls.mockResolvedValue(controls);
  mocks.getSignupFunnel.mockResolvedValue({
    windowDays: 30,
    totals: [],
    failures: [],
    hasData: false,
  });
  mocks.getAuthSmsHealth.mockResolvedValue({
    status: "ready",
    configured: true,
    otpTemplate: "verify",
    fromEnvironment: false,
    updatedAt: null,
    lastSentAt: null,
    failures24h: 0,
    failureBreakdown: [],
    openAlerts: { critical: 0, warning: 0, info: 0, total: 0 },
    alerts: [],
  });
});

describe("GET /api/platform/signup", () => {
  it("requires signup.read and refuses without it", async () => {
    const forbidden = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.requirePlatformCapability.mockResolvedValue({ session: null, error: forbidden });

    const res = await GET();
    expect(res.status).toBe(403);
    expect(mocks.requirePlatformCapability).toHaveBeenCalledWith("signup.read");
    expect(mocks.readSignupControls).not.toHaveBeenCalled();
  });

  it("returns the gate, funnel and safe SMS readiness with no-store", async () => {
    mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.gate).toEqual({
      enabled: false,
      reason: "environment_disabled",
      source: "environment",
    });
    // The API contract deliberately has no provider key/hint field.
    expect(JSON.stringify(body)).not.toMatch(/apiKey|keyHint|kavenegar/i);
  });
});

describe("PUT /api/platform/signup", () => {
  it("requires signup.manage and refuses without it", async () => {
    const forbidden = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.requirePlatformCapability.mockResolvedValue({ session: null, error: forbidden });

    const res = await PUT(put({ publicSignupEnabled: true, maintenanceMode: false }));
    expect(res.status).toBe(403);
    expect(mocks.requirePlatformCapability).toHaveBeenCalledWith("signup.manage");
    expect(mocks.saveSignupControls).not.toHaveBeenCalled();
    expect(mocks.platformAudit).not.toHaveBeenCalled();
  });

  it("rejects a body that does not explicitly set both booleans", async () => {
    mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });

    for (const body of [
      {},
      { publicSignupEnabled: "yes", maintenanceMode: false },
      { publicSignupEnabled: true, maintenanceMode: "no" },
    ]) {
      const res = await PUT(put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.saveSignupControls).not.toHaveBeenCalled();
  });

  it("rejects an over-long maintenance message", async () => {
    mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });

    const res = await PUT(
      put({
        publicSignupEnabled: true,
        maintenanceMode: true,
        maintenanceMessage: "x".repeat(501),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_maintenance_message" });
  });

  it("saves with the acting admin and audits the old and new values", async () => {
    mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });
    mocks.readSignupControls.mockResolvedValue({
      controls: { ...controls, publicSignupEnabled: false },
      readable: true,
    });

    const res = await PUT(
      put({ publicSignupEnabled: true, maintenanceMode: false, maintenanceMessage: null }),
    );
    expect(res.status).toBe(200);
    expect(mocks.saveSignupControls).toHaveBeenCalledWith(
      { publicSignupEnabled: true, maintenanceMode: false, maintenanceMessage: null },
      admin.padmin,
    );

    const audit = mocks.platformAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      adminId: admin.padmin,
      action: "signup.settings.update",
      entity: "platform_signup_settings",
      entityId: "1",
    });
    expect(audit.payload.publicSignupEnabled).toEqual({ from: false, to: true });
    expect(audit.payload.maintenanceMode).toEqual({ from: false, to: false });
    // No credential-shaped key may enter the audit payload.
    expect(JSON.stringify(audit.payload)).not.toMatch(/token|secret|password|code/i);
  });

  it("records that the environment gate was in charge before the first save", async () => {
    mocks.requirePlatformCapability.mockResolvedValue({ session: admin, error: null });

    await PUT(put({ publicSignupEnabled: true, maintenanceMode: false }));

    const audit = mocks.platformAudit.mock.calls[0][0];
    expect(audit.payload.previousSource).toBe("environment");
    expect(audit.payload.publicSignupEnabled.from).toBeNull();
  });
});
