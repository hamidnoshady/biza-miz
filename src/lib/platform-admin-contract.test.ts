import { describe, expect, it } from "vitest";
import {
  parsePlatformAdminCreate,
  parsePlatformAdminUpdate,
  platformAdminContractMessage,
  PLATFORM_ADMIN_SENSITIVE_ACTIONS,
} from "./platform-admin-contract";

describe("platform admin request contract (audit F01)", () => {
  it("creates only from email, name and a valid role — no initial password", () => {
    const parsed = parsePlatformAdminCreate({
      email: "  Ops@Example.COM ",
      fullName: " نام ",
      role: "support",
      password: "ignored-by-contract",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { email: "ops@example.com", fullName: "نام", role: "support" },
    });
  });

  it("names the failing field for create validation", () => {
    expect(parsePlatformAdminCreate({ email: "", fullName: "x", role: "owner" })).toMatchObject({
      ok: false,
      error: "missing_fields",
      field: "email",
    });
    expect(parsePlatformAdminCreate({ email: "a@b.c", fullName: "x", role: "root" })).toMatchObject({
      ok: false,
      error: "invalid_role",
      field: "role",
    });
    expect(parsePlatformAdminCreate({ email: "not-an-email", fullName: "x", role: "owner" })).toMatchObject({
      ok: false,
      error: "invalid_email",
    });
    expect(parsePlatformAdminCreate(null)).toEqual({ ok: false, error: "bad_request" });
  });

  it("rejects unknown or missing actions instead of treating them as updates", () => {
    expect(parsePlatformAdminUpdate({ adminId: "x", role: "owner" })).toMatchObject({
      ok: false,
      error: "invalid_action",
    });
    expect(parsePlatformAdminUpdate({ action: "send_password_reset", adminId: "x" })).toMatchObject({
      ok: false,
      error: "invalid_action",
    });
    expect(parsePlatformAdminUpdate({ action: "create", adminId: "x" })).toMatchObject({
      ok: false,
      error: "invalid_action",
    });
  });

  it("requires a target admin for every existing-admin action", () => {
    expect(parsePlatformAdminUpdate({ action: "revoke_sessions" })).toMatchObject({
      ok: false,
      error: "bad_request",
      field: "adminId",
    });
    expect(parsePlatformAdminUpdate({ action: "reset_password", adminId: "  " })).toMatchObject({
      ok: false,
      error: "bad_request",
    });
  });

  it("parses update fields and refuses an empty update", () => {
    expect(parsePlatformAdminUpdate({ action: "update", adminId: "a1", isActive: false })).toEqual({
      ok: true,
      value: { action: "update", adminId: "a1", isActive: false },
    });
    expect(parsePlatformAdminUpdate({ action: "update", adminId: "a1", role: "engineer" })).toEqual({
      ok: true,
      value: { action: "update", adminId: "a1", role: "engineer" },
    });
    expect(parsePlatformAdminUpdate({ action: "update", adminId: "a1" })).toEqual({
      ok: false,
      error: "nothing_to_update",
    });
    expect(parsePlatformAdminUpdate({ action: "update", adminId: "a1", role: "root" })).toMatchObject({
      ok: false,
      error: "invalid_role",
    });
    expect(parsePlatformAdminUpdate({ action: "update", adminId: "a1", isActive: "no" })).toMatchObject({
      ok: false,
      error: "bad_request",
      field: "isActive",
    });
  });

  it("treats every access-changing action as sensitive", () => {
    expect([...PLATFORM_ADMIN_SENSITIVE_ACTIONS].sort()).toEqual(
      ["reset_password", "revoke_sessions", "update"].sort(),
    );
  });

  it("gives operator-facing Persian text for known codes and a safe fallback otherwise", () => {
    expect(platformAdminContractMessage("last_platform_owner")).toMatch(/آخرین مالک/);
    expect(platformAdminContractMessage("unknown_code_xyz")).toMatch(/عملیات انجام نشد/);
  });
});
