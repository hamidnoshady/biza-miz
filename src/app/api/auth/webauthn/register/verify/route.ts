import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { PIN_ROLES } from "@/lib/roles";
import { requireRecentAuth } from "@/lib/recent-auth";
import { resolveDeviceId } from "@/lib/device-service";
import { requestHost } from "@/lib/host";
import { completeWebauthnRegistration, EmployeeError } from "@/lib/employee-service";
import { expectedOriginsFor } from "@/lib/webauthn";

/**
 * Step 2 of registering a biometric authenticator — verifies the ceremony
 * and stores the credential. Wave 4 — an optional `deviceToken` (this
 * terminal's paired-device token, if any) binds the new credential to that
 * device, so the login picker only offers it there; an unresolvable or
 * absent token leaves the credential unbound, visible on every terminal,
 * exactly as Wave 3 behaved.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole(...PIN_ROLES);
  if (error) return error;

  /** Issue #854 (P1.8): the ceremony's *storing* half needs the same bar. */
  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  let body: {
    response?: RegistrationResponseJSON;
    challengeToken?: string;
    deviceLabel?: string;
    deviceToken?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.response || !body.challengeToken) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const deviceId = await resolveDeviceId(body.deviceToken, session.businessId);
    const credential = await completeWebauthnRegistration(
      session.sub,
      session.businessId,
      session.sub,
      body.response,
      body.challengeToken,
      body.deviceLabel?.slice(0, 32) ?? null,
      deviceId,
      // Each business registers from its own origin, so the accepted origin is
      // this request's rather than a fixed one — see expectedOriginsFor.
      expectedOriginsFor(
        requestHost(request.headers),
        request.headers.get("x-forwarded-proto"),
        request.nextUrl.protocol,
      ),
    );
    return NextResponse.json({ credential });
  } catch (err) {
    if (err instanceof EmployeeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
