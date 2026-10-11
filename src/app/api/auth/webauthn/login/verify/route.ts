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
import { PASSWORD_ROLES, PIN_ROLES } from "@/lib/roles";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
} from "@/lib/mfa-service";
import { getMfaPolicy } from "@/lib/mfa-policy";
import { isPrivilegedMfaRole, mfaAppliesToRole } from "@/lib/mfa";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  platform_user_id: string | null;
  token_version: number | null;
}

/**
 * Step 2 of a biometric login — verifies the signed assertion and, on
 * success, mints an `employee_sessions` row plus the same JWT `pin-login`
 * would (`employeeSessionId` included, `checkEmployeeSession` re-checks it
 * live exactly as it does for a PIN login — biometric is a different way to
 * prove identity, not a different kind of session).
 *
 * ## Issue #854 (P0.6 / P1.20): the same door as the PIN, so the same rules
 *
 * Biometric is a faster way to *prove the PIN holder*, not a second door with
 * its own policy — but the two had drifted:
 *
 *  - the roster offered a biometric prompt to `owner`/`admin`/`manager`/
 *    `accountant` on a Local/Hybrid install (where the privileged site-PIN door
 *    is deliberate, so the site runs with the uplink down) while this route
 *    accepted only `cashier`/`waiter`/`kitchen`, so the offered button always
 *    failed with `invalid_credentials` (P1.20);
 *  - and because it accepted only the floor roles, it never had to ask the
 *    second-factor question — until the roster was fixed, at which point a
 *    privileged biometric login would have been the MFA bypass P0.6 describes.
 *
 * Both are now answered by doing exactly what `pin-login` does: the same role
 * set (`PIN_ROLES`, plus the privileged site door off-cloud), the same MFA
 * policy question, and the same `platformUserId`/`tokenVersion` claims — a
 * privileged member who signs in here is a *global* identity, not the anonymous
 * `platformUserId: null` session the finding called out.
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

    const deployment = await readDeploymentProfile(businessId);
    const rolePool = [
      ...PIN_ROLES,
      /**
       * The privileged site door, off-cloud only — the same condition the
       * roster and `pin-login` use, so the three cannot disagree.
       */
      ...(deployment.profile === "cloud" ? [] : PASSWORD_ROLES),
    ];

    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id, u.role, u.full_name,
              u.platform_user_id, p.token_version
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1 AND u.is_active AND u.role::text = ANY($2::text[])`,
      [body.employeeId, rolePool],
    );
    const user = rows[0];
    if (!user) {
      await auditLoginFailure(businessId, body.employeeId!, "employee_inactive");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    /**
     * Issue #854 (P0.6), the same refusal `pin-login` makes: a role whose
     * second factor is required — or which has one — must not enter through a
     * door that cannot ask for it.
     */
    if (isPrivilegedMfaRole(user.role)) {
      const policy = await getMfaPolicy(user.business_id);
      const requiresMfa = mfaAppliesToRole(user.role, policy);
      const enrolments = user.platform_user_id
        ? filterActiveMfaEnrolments(
            await getAccountMfaEnrolments("platform_user", user.platform_user_id),
          )
        : [];
      if (requiresMfa || enrolments.length > 0) {
        await auditLoginFailure(businessId, user.id, "privileged_biometric_mfa_required");
        return NextResponse.json(
          {
            error: "mfa_required",
            message:
              "ورود دومرحله‌ای برای این نقش لازم است؛ از ورود با رمز عبور و کد دومرحله‌ای استفاده کنید.",
          },
          { status: 403 },
        );
      }
    }

    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, businessId);
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
      credentialId: result.credentialId,
      deviceLabel,
      deviceId,
      loginMethod: "webauthn",
      userAgent: request.headers.get("user-agent"),
    });

    const token = await signSession({
      sub: user.id,
      role: user.role,
      businessId: user.business_id,
      businessSlug: user.business_slug,
      businessSubdomain: user.business_subdomain,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: user.platform_user_id,
      tokenVersion: user.token_version ?? undefined,
      employeeSessionId: employeeSession.id,
      /**
       * A fresh assertion is a fresh authentication — the same stamp
       * `pin-login` and the password door set, so a biometric login does not
       * arrive already stale for step-up.
       */
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
