import { NextRequest, NextResponse } from "next/server";
import {
  normalizeMaintenanceMessage,
  readSignupControls,
  resolveSignupGate,
  saveSignupControls,
} from "@/lib/iam/signup-controls";
import { getAuthSmsHealth, getSignupFunnel } from "@/lib/iam/signup-events";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

/**
 * Issue #1388 — the Superadmin public-registration desk.
 *
 * `GET` reads the registration control, its effective gate, the authentication
 * SMS readiness and the signup/onboarding funnel. `PUT` flips the control and
 * writes an audit row naming the operator, the old value and the new value.
 *
 * Capabilities: `signup.read` for the read half (every admin role), and
 * `signup.manage` for the write half (engineer + owner). The console is a UI
 * convenience; these guard the server.
 *
 * Nothing here can return a provider secret, an OTP, a password or a national
 * ID: the settings read never selects the API key, and the funnel is ids and
 * counters only.
 */
function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("signup.read");
  if (error) return error;

  const read = await readSignupControls();
  const gate = resolveSignupGate(read.controls, process.env.ALLOW_PUBLIC_SIGNUP);
  const [funnel, sms] = await Promise.all([getSignupFunnel(30), getAuthSmsHealth()]);

  return noStore({
    controls: read.controls,
    readable: read.readable,
    gate,
    /** The raw deployment gate, so the console can explain the fallback. */
    environmentGateEnabled: process.env.ALLOW_PUBLIC_SIGNUP === "true",
    funnel,
    sms,
  });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("signup.manage");
  if (error) return error;

  let body: {
    publicSignupEnabled?: unknown;
    maintenanceMode?: unknown;
    maintenanceMessage?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return noStore({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.publicSignupEnabled !== "boolean" || typeof body.maintenanceMode !== "boolean") {
    return noStore({ error: "bad_request" }, { status: 400 });
  }
  const message = normalizeMaintenanceMessage(body.maintenanceMessage);
  if (message === "invalid") {
    return noStore(
      { error: "invalid_maintenance_message", maxLength: 500 },
      { status: 400 },
    );
  }

  const before = await readSignupControls();
  const controls = await saveSignupControls(
    {
      publicSignupEnabled: body.publicSignupEnabled,
      maintenanceMode: body.maintenanceMode,
      maintenanceMessage: message,
    },
    session.padmin,
  );

  // The audit row is the accountability contract for a consequential setting:
  // who changed it, when (the row's own created_at), and the old/new values.
  // `null` in `from` means "no stored control — the environment gate decided",
  // which is a fact an operator needs when reading the history back.
  await platformAudit({
    adminId: session.padmin,
    action: "signup.settings.update",
    entity: "platform_signup_settings",
    entityId: "1",
    payload: {
      publicSignupEnabled: {
        from: before.controls?.publicSignupEnabled ?? null,
        to: controls.publicSignupEnabled,
      },
      maintenanceMode: {
        from: before.controls?.maintenanceMode ?? null,
        to: controls.maintenanceMode,
      },
      maintenanceMessageChanged:
        (before.controls?.maintenanceMessage ?? null) !== controls.maintenanceMessage,
      previousSource: before.controls ? "runtime" : "environment",
    },
  });

  const gate = resolveSignupGate(controls, process.env.ALLOW_PUBLIC_SIGNUP);
  return noStore({ controls, gate, readable: true });
});
