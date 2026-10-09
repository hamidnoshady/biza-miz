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
import { boundedString, normalizeOtpCode } from "@/lib/login-contract";
import {
  issueTrustedDevice,
  trustedDeviceCookieOptions,
  TRUSTED_DEVICE_COOKIE,
} from "@/lib/trusted-device";
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
  let body: { code?: unknown; deviceToken?: unknown; trustDevice?: unknown };
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

  // Issue #885 L11 — Persian and Arabic-Indic digits are canonicalised before
  // the shape check, at the API boundary as well as in the input. The old
  // `/^\d{6}$/` here rejected a code typed on a Persian keyboard even when the
  // client had already stripped it, because the client stripped it by deleting
  // those digits rather than converting them.
  // Issue #885 L14 — the device token names a row; bound it before it reaches
  // `resolveDeviceId` rather than letting an arbitrary JSON value through.
  const deviceToken = boundedString(body.deviceToken, { max: 256, required: false });
  /**
   * The member ticked «اعتماد به این دستگاه برای ۷ روز». Honouring it is safe
   * here and only here: this branch is reached after the OTP was verified and
   * no further factor is outstanding, which is exactly the "all required
   * verification succeeded" the policy names as the precondition.
   */
  const wantsTrust = body.trustDevice === true;

  const code = normalizeOtpCode(body.code);
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  // The anti-enumeration token from a number nothing matched: no subject, no
  // challenge, and the only honest answer is the one a wrong code gets.
  //
  // The status and the code both have to match the wrong-code answer, not
  // merely be "a 401". If this branch answered `unauthorized` instead, a caller
  // who typed a number could read the response and learn whether it matched a
  // member — which is precisely the oracle issue #885 L15 asks to remove, and
  // the request route works to suppress on its side too.
  if (!payload.sub) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  // A named member with no challenge bound to the token. This is a pre-#885
  // token (the TTL is ten minutes, so at most a deploy's worth are in flight):
  // it predates the binding and names no row, so there is nothing it could be
  // redeemed against. Answering differently from a wrong code is safe here and
  // only here — reaching this branch already required a token naming a real
  // member, so it discloses nothing an attacker did not already prove.
  if (!payload.cid || !payload.destination) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Locals, not `payload.*`: TypeScript does not carry a property narrowing
  // into the async callback below, and every one of these is used inside it.
  const subjectId = payload.sub;
  const challengeId = payload.cid;
  const destination = payload.destination;
  const purpose = payload.purpose;
  const businessId = payload.businessId;

  return withTenant(businessId, async () => {
    const lockout = await checkLoginLockout(businessId, subjectId);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    // Issue #885 L02/L03 — redeem exactly the challenge this token names, and
    // only if it still belongs to this member, this tenant, this ceremony and
    // this destination. The consume is one conditional UPDATE, so two
    // concurrent valid submissions cannot both be told "verified".
    const verification = await verifyEmployeePhoneOtp({
      challengeId,
      userId: subjectId,
      businessId,
      purpose,
      destination,
      code,
    });
    if (!verification.verified) {
      // `scope_mismatch` is a token that does not describe the row it names —
      // a replay across ceremonies, or a forged claim. It is audited as a
      // failed login and answered exactly like a wrong code, because the
      // difference is only interesting server-side.
      await auditLoginFailure(businessId, subjectId, "invalid_phone_otp");
      return NextResponse.json(
        { error: verification.reason === "expired" ? "code_expired" : "invalid_code" },
        { status: 401 },
      );
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
      [subjectId, businessId],
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
            // Not all factors are complete yet, so trust is *offered* rather
            // than granted. The MFA step carries the intent forward and
            // /api/auth/mfa/verify is what actually issues it — a device that
            // has not finished every factor must not be trusted by the step
            // that came before the last one.
            trustOffered: wantsTrust,
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
    const deviceId = await resolveDeviceId(deviceToken, member.business_id);
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

    // Issue #885 — every required factor is now satisfied on this request, so
    // this is the one place the seven-day trust may be earned. Best-effort:
    // the login itself is already complete and must not fail because a
    // convenience row could not be written.
    if (wantsTrust) {
      const trust = await issueTrustedDevice({
        businessId: member.business_id,
        userId: member.id,
        platformUserId: member.platform_user_id,
        deviceToken,
        deviceLabel,
        factorSummary: "phone_otp",
      }).catch((err) => {
        console.error("Trusted-device registration failed", err);
        return null;
      });
      if (trust) {
        res.cookies.set(TRUSTED_DEVICE_COOKIE, trust.token, trustedDeviceCookieOptions());
      }
    }

    return res;
  });
}
