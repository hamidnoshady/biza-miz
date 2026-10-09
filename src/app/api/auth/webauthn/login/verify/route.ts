import { WEBAUTHN_LOGIN_ROLES_SQL } from "@/lib/login-eligibility";
import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { resolveDeviceId } from "@/lib/device-service";
import { requestHost } from "@/lib/host";
import {
  auditLoginFailure,
  checkLoginLockout,
  completeWebauthnAuthentication,
  createSession,
  resolveLoginBusinessId,
} from "@/lib/employee-service";
import { expectedOriginsFor } from "@/lib/webauthn";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  location_id: string | null;
  role: Role;
  full_name: string;
}

/**
 * Step 2 of a biometric login — verifies the signed assertion and, on
 * success, mints an `employee_sessions` row plus the same JWT `pin-login`
 * would (`employeeSessionId` included, `checkEmployeeSession` re-checks it
 * live exactly as it does for a PIN login — biometric is a different way to
 * prove identity, not a different kind of session).
 */
export async function POST(request: NextRequest) {
  let body: {
    employeeId?: string;
    response?: AuthenticationResponseJSON;
    challengeToken?: string;
    businessId?: string;
    businessSlug?: string;
    locationId?: string;
    deviceToken?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.employeeId || !body.response || !body.challengeToken) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { businessId, error } = await resolveLoginBusinessId({
    ...body,
    host: requestHost(request.headers),
  });
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    // Phase 20 Wave 8 — employeeId is always known here (the picker chose
    // them before offering biometric at all), so this can check before
    // attempting the ceremony at all, same as pin-login's picker-narrowed case.
    const lockout = await checkLoginLockout(businessId, body.employeeId!);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const result = await completeWebauthnAuthentication(
      body.employeeId!,
      businessId,
      body.response!,
      body.challengeToken!,
      // The ceremony happened on this business's own origin, which no fixed
      // WEBAUTHN_ORIGIN list can enumerate — see expectedOriginsFor.
      expectedOriginsFor(
        requestHost(request.headers),
        request.headers.get("x-forwarded-proto"),
        request.nextUrl.protocol,
      ),
    );
    if (!result) {
      // Phase 20 Wave 7 — same visibility pin-login's failure path just
      // gained; employeeId is always known here (the picker chose them
      // before offering biometric at all).
      await auditLoginFailure(businessId, body.employeeId!, "invalid_assertion");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id, u.role, u.full_name
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.id = $1 AND u.is_active AND u.role IN ${WEBAUTHN_LOGIN_ROLES_SQL}`,
      [body.employeeId],
    );
    const user = rows[0];
    if (!user) {
      await auditLoginFailure(businessId, body.employeeId!, "employee_inactive");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, businessId);
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
      credentialId: result.credentialId,
      deviceLabel,
      deviceId,
    });

    const token = await signSession({
      sub: user.id,
      role: user.role,
      businessId: user.business_id,
      businessSlug: user.business_slug,
      businessSubdomain: user.business_subdomain,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: null,
      employeeSessionId: employeeSession.id,
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
