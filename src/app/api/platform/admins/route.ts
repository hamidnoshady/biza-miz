import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import {
  parsePlatformAdminCreate,
  parsePlatformAdminUpdate,
  platformAdminContractMessage,
  PLATFORM_ADMIN_SENSITIVE_ACTIONS,
} from "@/lib/platform-admin-contract";
import {
  createPlatformAdmin,
  initiatePlatformAdminPasswordReset,
  listPlatformAdmins,
  revokePlatformAdminAccessSessions,
  updatePlatformAdmin,
} from "@/lib/platform-service";

/**
 * Superadmin management. The contract lives in `platform-admin-contract.ts`:
 * POST creates an administrator; PATCH applies one typed `action` to an
 * existing administrator (`adminId`). Every mutation requires `admins.manage`
 * and a recent authentication (15 minutes) — the console retries after the
 * step-up prompt.
 */

function contractError(error: string, field?: string) {
  return NextResponse.json(
    { error, ...(field ? { field } : {}), message: platformAdminContractMessage(error) },
    { status: error === "recent_auth_required" ? 403 : 400 },
  );
}

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  return NextResponse.json({ admins: await listPlatformAdmins() });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return contractError("bad_request");
  }

  const parsed = parsePlatformAdminCreate(body);
  if (!parsed.ok) return contractError(parsed.error, parsed.field);

  const recentError = requireRecentAuth(session);
  if (recentError) return recentError;

  const result = await createPlatformAdmin({
    ...parsed.value,
    actorAdminId: session.padmin,
  });

  if (!result.ok) {
    const status = result.error === "email_taken" ? 409 : 400;
    return NextResponse.json(
      { error: result.error, message: platformAdminContractMessage(result.error) },
      { status },
    );
  }

  // The invitee sets their own password through this one-time link; no
  // credential is shown to, or chosen by, the administrator who invites them.
  return NextResponse.json({
    ok: true,
    admin: result.admin,
    resetExpiresAt: result.resetExpiresAt,
    resetUrl: `/reset-password?token=${encodeURIComponent(result.resetToken)}`,
  });
});

export const PATCH = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("admins.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return contractError("bad_request");
  }

  const parsed = parsePlatformAdminUpdate(body);
  if (!parsed.ok) return contractError(parsed.error, parsed.field);
  const input = parsed.value;

  if (PLATFORM_ADMIN_SENSITIVE_ACTIONS.includes(input.action)) {
    const recentError = requireRecentAuth(session);
    if (recentError) return recentError;
  }

  if (input.action === "revoke_sessions") {
    const res = await revokePlatformAdminAccessSessions({
      targetAdminId: input.adminId,
      actorAdminId: session.padmin,
    });
    if (!res.ok) return contractError(res.error);
    return NextResponse.json({ ok: true, revokedSessions: res.revokedSessions });
  }

  if (input.action === "reset_password") {
    const res = await initiatePlatformAdminPasswordReset({
      targetAdminId: input.adminId,
      actorAdminId: session.padmin,
    });
    if (!res.ok) return contractError(res.error);
    return NextResponse.json({
      ok: true,
      email: res.email,
      resetExpiresAt: res.expiresAt,
      resetUrl: `/reset-password?token=${encodeURIComponent(res.token)}`,
    });
  }

  if (input.isActive === false && input.adminId === session.padmin) {
    return NextResponse.json(
      { error: "cannot_deactivate_self", message: platformAdminContractMessage("cannot_deactivate_self") },
      { status: 409 },
    );
  }

  const updated = await updatePlatformAdmin({
    targetAdminId: input.adminId,
    fullName: input.fullName,
    role: input.role,
    isActive: input.isActive,
    actorAdminId: session.padmin,
  });

  if (!updated.ok) {
    const status =
      updated.error === "not_found" ? 404 : updated.error === "last_platform_owner" ? 409 : 400;
    return NextResponse.json(
      { error: updated.error, message: platformAdminContractMessage(updated.error) },
      { status },
    );
  }

  return NextResponse.json({ ok: true, admin: updated.admin });
});
