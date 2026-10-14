/**
 * Route-level regression for the superadmin administrator contract (audit F01).
 *
 * These call the REAL exported handlers with real request bodies. Only the
 * auth boundary and the service layer are replaced, so the assertions cover
 * what the console actually sends: the right HTTP method, the typed body, the
 * recent-auth gate, the self-deactivation guard and the service arguments.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = { padmin: "admin-self", role: "owner" as const, recentAuthAt: 0 };

const mocks = vi.hoisted(() => ({
  requirePlatformCapability: vi.fn(),
  createPlatformAdmin: vi.fn(),
  updatePlatformAdmin: vi.fn(),
  revokePlatformAdminAccessSessions: vi.fn(),
  initiatePlatformAdminPasswordReset: vi.fn(),
  listPlatformAdmins: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformCapability: mocks.requirePlatformCapability,
  withPlatformScope: <A extends unknown[]>(h: (...args: A) => unknown) => h,
}));

vi.mock("@/lib/platform-service", () => ({
  createPlatformAdmin: mocks.createPlatformAdmin,
  updatePlatformAdmin: mocks.updatePlatformAdmin,
  revokePlatformAdminAccessSessions: mocks.revokePlatformAdminAccessSessions,
  initiatePlatformAdminPasswordReset: mocks.initiatePlatformAdminPasswordReset,
  listPlatformAdmins: mocks.listPlatformAdmins,
}));

import * as route from "./route";

function jsonRequest(method: string, body: unknown): Request {
  return new Request("https://admin.example.test/api/platform/admins", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(method: "POST" | "PATCH", body: unknown) {
  const handler = method === "POST" ? route.POST : route.PATCH;
  const res = await (handler as unknown as (r: Request) => Promise<Response>)(jsonRequest(method, body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function setSession(recentAuthAt: number) {
  mocks.requirePlatformCapability.mockResolvedValue({
    session: { ...session, recentAuthAt },
    error: undefined,
  });
}

const FRESH = () => Math.floor(Date.now() / 1000);
const STALE = () => Math.floor(Date.now() / 1000) - 60 * 60;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/platform/admins — create", () => {
  it("creates an invited admin from a fresh session and never accepts a password", async () => {
    setSession(FRESH());
    mocks.createPlatformAdmin.mockResolvedValue({
      ok: true,
      admin: { id: "new-1" },
      resetToken: "tok",
      resetExpiresAt: "2026-10-13T00:00:00.000Z",
    });

    const res = await call("POST", {
      email: "NEW@example.com",
      fullName: "کاربر جدید",
      role: "engineer",
      password: "should-not-be-used-123",
    });

    expect(res.status).toBe(200);
    expect(res.json.resetUrl).toBe("/reset-password?token=tok");
    expect(mocks.createPlatformAdmin).toHaveBeenCalledWith({
      email: "new@example.com",
      fullName: "کاربر جدید",
      role: "engineer",
      actorAdminId: "admin-self",
    });
  });

  it("requires recent authentication and does not touch the service when stale", async () => {
    setSession(STALE());
    const res = await call("POST", { email: "a@b.co", fullName: "x", role: "support" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("recent_auth_required");
    expect(mocks.createPlatformAdmin).not.toHaveBeenCalled();
  });

  it("returns field-level contract errors before any write", async () => {
    setSession(FRESH());
    const res = await call("POST", { email: "a@b.co", fullName: "x", role: "root" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid_role", field: "role" });
    expect(mocks.createPlatformAdmin).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/platform/admins — existing-admin actions", () => {
  it("applies a role change through the typed update action", async () => {
    setSession(FRESH());
    mocks.updatePlatformAdmin.mockResolvedValue({ ok: true, admin: { id: "t1" } });

    const res = await call("PATCH", { action: "update", adminId: "t1", role: "support" });

    expect(res.status).toBe(200);
    expect(mocks.updatePlatformAdmin).toHaveBeenCalledWith({
      targetAdminId: "t1",
      fullName: undefined,
      role: "support",
      isActive: undefined,
      actorAdminId: "admin-self",
    });
  });

  it("rejects a request with no action rather than guessing it is an update", async () => {
    setSession(FRESH());
    const res = await call("PATCH", { adminId: "t1", role: "support" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_action");
    expect(mocks.updatePlatformAdmin).not.toHaveBeenCalled();
  });

  it("rejects the retired send_password_reset vocabulary", async () => {
    setSession(FRESH());
    const res = await call("PATCH", { action: "send_password_reset", adminId: "t1" });
    expect(res.status).toBe(400);
    expect(mocks.initiatePlatformAdminPasswordReset).not.toHaveBeenCalled();
  });

  it("issues a reset link through reset_password, behind recent auth", async () => {
    setSession(FRESH());
    mocks.initiatePlatformAdminPasswordReset.mockResolvedValue({
      ok: true,
      token: "rt",
      expiresAt: "2026-10-13T00:00:00.000Z",
      email: "t@x.co",
    });
    const res = await call("PATCH", { action: "reset_password", adminId: "t1" });
    expect(res.status).toBe(200);
    expect(res.json.resetUrl).toBe("/reset-password?token=rt");
  });

  it("gates revoke_sessions and reset_password on recent authentication", async () => {
    setSession(STALE());
    const revoke = await call("PATCH", { action: "revoke_sessions", adminId: "t1" });
    const reset = await call("PATCH", { action: "reset_password", adminId: "t1" });
    expect(revoke.json.error).toBe("recent_auth_required");
    expect(reset.json.error).toBe("recent_auth_required");
    expect(mocks.revokePlatformAdminAccessSessions).not.toHaveBeenCalled();
    expect(mocks.initiatePlatformAdminPasswordReset).not.toHaveBeenCalled();
  });

  it("refuses to deactivate the signed-in administrator", async () => {
    setSession(FRESH());
    const res = await call("PATCH", { action: "update", adminId: "admin-self", isActive: false });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("cannot_deactivate_self");
    expect(mocks.updatePlatformAdmin).not.toHaveBeenCalled();
  });

  it("maps last-owner protection from the service to a conflict", async () => {
    setSession(FRESH());
    mocks.updatePlatformAdmin.mockResolvedValue({ ok: false, error: "last_platform_owner" });
    const res = await call("PATCH", { action: "update", adminId: "t1", role: "support" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("last_platform_owner");
  });
});
