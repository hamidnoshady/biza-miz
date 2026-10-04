import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { resolveDeviceId } from "@/lib/device-service";
import {
  auditLoginFailure,
  checkLoginLockout,
  createSession,
  ensureEmployeeProfile,
} from "@/lib/employee-service";
import {
  stampPhoneVerified,
  verifyEmployeePhoneOtp,
  verifyPhonePendingToken,
} from "@/lib/phone-otp";
import {
  distinctSecondFactorMethods,
  enrolmentRequirement,
  graceDaysRemaining,
  mfaAppliesToRole,
  MFA_GRACE_DAYS_TENANT,
  shouldChallengeMfaOnLogin,
} from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  markMfaGracePeriod,
  signMfaPendingToken,
} from "@/lib/mfa-service";

interface MemberRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  platform_user_id: string | null;
  identity_active: boolean | null;
  token_version: number | null;
}

/**
 * Phase 42 — the second half of the phone-OTP door.
 *
 * Issue #809 (Finding 1 — P0): Phone OTP is primary authentication only.
 * For Owner/Manager accounts (or any account with enrolled MFA), phone OTP
 * must evaluate the same MFA policy as password login and require a DISTINCT
 * second factor (`totp` or recovery code — never counting the same SMS OTP
 * as both primary and second factor) before minting the tenant session.
 */
export async function POST(request: NextRequest) {
  let body: { code?: string; deviceToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await verifyPhonePendingToken(bearer);
  if (!payload) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const code = body.code ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  // The anti-enumeration token from a number nothing matched: no subject, no
  // challenge, and the only honest answer is the one a wrong code gets.
  if (!payload.sub) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  return withTenant(payload.businessId, async () => {
    const lockout = await checkLoginLockout(payload.businessId, payload.sub!);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    const ok = await verifyEmployeePhoneOtp({ userId: payload.sub!, code });
    if (!ok) {
      await auditLoginFailure(payload.businessId, payload.sub!, "invalid_phone_otp");
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    const { rows } = await query<MemberRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id,
              u.role, u.full_name, u.platform_user_id,
              p.is_active AS identity_active, p.token_version
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active AND b.status = 'active'`,
      [payload.sub, payload.businessId],
    );
    const member = rows[0];
    if (!member || member.identity_active === false) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    await stampPhoneVerified({
      businessId: payload.businessId,
      userId: member.id,
      phone: payload.mayAttachPhone ? (payload.phone ?? null) : null,
    });

    let graceNotice: {
      mfaState: "grace";
      graceUntil: string | null;
      graceDaysLeft: number | null;
    } | null = null;

    if (member.platform_user_id) {
      const mfaPolicy = await getMfaPolicy(member.business_id);
      const requiresMfa = mfaAppliesToRole(member.role, mfaPolicy.requireForManagers);
      const allEnrolments = await getAccountMfaEnrolments(
        "platform_user",
        member.platform_user_id,
      );
      const activeEnrolments = filterActiveMfaEnrolments(allEnrolments);
      const distinctMethods = distinctSecondFactorMethods(activeEnrolments, "phone_otp");

      if (requiresMfa || activeEnrolments.length > 0) {
        let graceUntil = await getMfaGracePeriod("platform_user", member.platform_user_id);
        const hasGraceRecord = graceUntil !== null;

        if (requiresMfa && !hasGraceRecord && activeEnrolments.length === 0) {
          await markMfaGracePeriod(
            "platform_user",
            member.platform_user_id,
            MFA_GRACE_DAYS_TENANT,
          );
          graceUntil = await getMfaGracePeriod("platform_user", member.platform_user_id);
        }

        const req = enrolmentRequirement({
          hasPrimary: activeEnrolments.length > 0,
          graceUntil,
          hasGraceRecord,
          role: member.role,
        });

        if (
          shouldChallengeMfaOnLogin({
            hasConfirmedEnrolment: activeEnrolments.length > 0,
            appliesToRole: requiresMfa,
            requirement: req,
          })
        ) {
          const mfaToken = await signMfaPendingToken({
            sub: member.platform_user_id,
            method: distinctMethods[0] ?? null,
            authRealm: "tenant_password",
            businessId: member.business_id,
            primaryAuth: "phone_otp",
          });

          return NextResponse.json({
            mfaRequired: true,
            mfaState: req,
            mfaToken,
            mfaMethod: distinctMethods[0] ?? null,
            availableMethods: distinctMethods,
            primaryAuth: "phone_otp",
          });
        }

        if (requiresMfa && req === "grace") {
          graceNotice = {
            mfaState: "grace",
            graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
            graceDaysLeft: graceDaysRemaining(graceUntil),
          };
        }
      }
    }

    await ensureEmployeeProfile(member.id, member.business_id);
    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, member.business_id);
    const { session: employeeSession } = await createSession(member.id, member.business_id, {
      locationId: member.location_id,
      deviceLabel,
      deviceId,
    });

    const token = await signSession({
      sub: member.id,
      role: member.role,
      businessId: member.business_id,
      businessSlug: member.business_slug,
      businessSubdomain: member.business_subdomain,
      locationId: member.location_id,
      fullName: member.full_name,
      platformUserId: member.platform_user_id,
      tokenVersion: member.token_version ?? undefined,
      employeeSessionId: employeeSession.id,
      mfaVerified: false,
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    const res = NextResponse.json({
      user: { id: member.id, role: member.role, fullName: member.full_name },
      ...(graceNotice ?? {}),
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
