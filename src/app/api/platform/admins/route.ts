import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  createPlatformAdmin,
  initiatePlatformAdminPasswordReset,
  isValidPlatformAdminRole,
  listPlatformAdmins,
  revokePlatformAdminAccessSessions,
  updatePlatformAdmin,
} from "@/lib/platform-service";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  return NextResponse.json({ admins: await listPlatformAdmins() });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  let body: { email?: string; fullName?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isValidPlatformAdminRole(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const result = await createPlatformAdmin({
    email: typeof body.email === "string" ? body.email : "",
    fullName: typeof body.fullName === "string" ? body.fullName : "",
    role: body.role,
    actorAdminId: session.padmin,
  });

  if (!result.ok) {
    const status = result.error === "email_taken" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    admin: result.admin,
    resetToken: result.resetToken,
    resetExpiresAt: result.resetExpiresAt,
    resetUrl: `/reset-password?token=${encodeURIComponent(result.resetToken)}`,
  });
});

export const PATCH = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  let body: {
    action?: string;
    adminId?: string;
    fullName?: string;
    role?: string;
    isActive?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const targetAdminId = typeof body.adminId === "string" ? body.adminId : "";
  if (!targetAdminId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "revoke_sessions") {
    const res = await revokePlatformAdminAccessSessions({
      targetAdminId,
      actorAdminId: session.padmin,
    });
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 404 });
    }
    return NextResponse.json({ ok: true, revokedSessions: res.revokedSessions });
  }

  if (body.action === "reset_password") {
    const res = await initiatePlatformAdminPasswordReset({
      targetAdminId,
      actorAdminId: session.padmin,
    });
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      email: res.email,
      resetToken: res.token,
      resetExpiresAt: res.expiresAt,
      resetUrl: `/reset-password?token=${encodeURIComponent(res.token)}`,
    });
  }

  if (body.role !== undefined && !isValidPlatformAdminRole(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  const updated = await updatePlatformAdmin({
    targetAdminId,
    fullName: body.fullName,
    role: body.role,
    isActive: body.isActive,
    actorAdminId: session.padmin,
  });

  if (!updated.ok) {
    const status =
      updated.error === "not_found"
        ? 404
        : updated.error === "last_platform_owner"
          ? 409
          : 400;
    return NextResponse.json({ error: updated.error }, { status });
  }

  return NextResponse.json({ ok: true, admin: updated.admin });
});
