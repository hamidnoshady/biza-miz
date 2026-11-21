/**
 * ESH-203 / #1388 — the Superadmin's public-registration switch.
 *
 * One boolean, one audited writer. The value is enforced server-side by the
 * public signup routes themselves (`requestSignupOtp` / `verifySignupOtp`), not
 * by hiding the UI: closing the door has to hold for a caller who never loads
 * it.
 *
 * Authentication SMS configuration and provider health already live in the
 * console's messaging/security surfaces (`platform_sms_config`, #902) and are
 * reused as-is — this route deliberately does not grow a second SMS system.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  readPlatformAuthSettings,
  setPublicSignupEnabled,
} from "@/lib/iam/platform-auth-settings";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("security.manage");
  if (error) return error;
  return NextResponse.json({ settings: await readPlatformAuthSettings() });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("security.manage");
  if (error) return error;

  let body: { publicSignupEnabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.publicSignupEnabled !== "boolean") {
    return NextResponse.json({ error: "invalid_setting" }, { status: 400 });
  }

  const settings = await setPublicSignupEnabled({
    enabled: body.publicSignupEnabled,
    updatedBy: session.padmin,
  });

  // Security-sensitive setting: the change is audited with the actor and the
  // new value. No phone, OTP, credential or national ID is ever recorded here.
  await platformAudit({
    adminId: session.padmin,
    action: "auth.public_signup.update",
    entity: "platform_auth_settings",
    entityId: "1",
    payload: { publicSignupEnabled: settings.publicSignupEnabled },
  });

  return NextResponse.json({ settings });
});
