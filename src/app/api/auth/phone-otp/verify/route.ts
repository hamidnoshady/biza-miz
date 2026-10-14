import { NextRequest, NextResponse } from "next/server";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { resolveDeviceId } from "@/lib/device-service";
import {
  auditLoginFailure,
  checkLoginLockout,
  createSession,
  ensureEmployeeProfile,
} from "@/lib/employee-service";
import {
  PENDING_PHONE_REALM,
  signPhonePendingToken,
  stampPhoneVerified,
  verifyEmployeePhoneOtp,
  verifyPhonePendingToken,
} from "@/lib/phone-otp";
import { normalizeOtpCode, phoneDerivedSubject, redeemOtpChallenge } from "@/lib/otp-challenge";
import { boundedString } from "@/lib/login-contract";
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
  issueTrustedDevice,
  readTrustedDeviceToken,
  TRUSTED_DEVICE_COOKIE,
  trustedDeviceCookieOptions,
  verifyTrustedDevice,
} from "@/lib/trusted-device";
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
  phone_e164: string | null;
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
  let body: { code?: string; deviceToken?: string; businessId?: string; trustDevice?: boolean };
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

  /*
   * Issue #885 L11 — canonicalise *before* the shape check, not after.
   *
   * A bare `/^\d{6}$/` test on the raw input rejects Persian and Arabic-Indic
   * digits, which is what a member of a Persian-first product actually types:
   * they read «۱۲۳۴۵۶» off the SMS and key it in, and were told the code was
   * invalid. `normalizeOtpCode` folds the digits first and then applies the
   * same six-digit rule, so the gate is no stricter — it just stops rejecting
   * the digits this product's users type.
   */
  const code = normalizeOtpCode(body.code) ?? "";
  /**
   * Issue #885 L14 — the device token names a row. Bound it here, at the
   * boundary, rather than letting an arbitrary JSON value through to a row
   * lookup: over the bound it is dropped, not forwarded.
   */
  const deviceToken = boundedString(body.deviceToken, { max: 256, required: false });

  /**
   * Issue #854 (P1.19) — step three of a multi-business login: the member has
   * already proven the number (the token says `otpProven`) and is now naming
   * which business to enter. No second code is asked for; the selection token is
   * the proof, and it only exists because a code was actually redeemed.
   */
  if (payload.otpProven && payload.candidatePhone && body.businessId) {
    const chosenBusinessId = body.businessId;
    const provenPhone = payload.candidatePhone;
    return withTenant(chosenBusinessId, async () => {
      /**
       * The membership is resolved by the *number that was proven*, not by an
       * id the client supplied — so a selection token cannot be spent on a
       * membership that does not hold this phone.
       */
      const { rows } = await query<MemberRow>(
        `SELECT u.id, u.business_id, b.slug::text AS business_slug,
                b.subdomain::text AS business_subdomain, u.location_id,
                u.role, u.full_name, u.phone_e164, u.platform_user_id,
                p.is_active AS identity_active, p.token_version
           FROM users u
           JOIN businesses b ON b.id = u.business_id
           LEFT JOIN platform_users p ON p.id = u.platform_user_id
          WHERE u.business_id = $1 AND u.phone_e164 = $2
            AND u.phone_verified_at IS NOT NULL
            AND u.is_active AND b.status = 'active'`,
        [chosenBusinessId, provenPhone],
      );
      const member = rows[0];
      if (!member || member.identity_active === false) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 401 });
      }
      const lockout = await checkLoginLockout(member.business_id, member.id);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }
      return completePhoneLogin(member, {
        attachPhone: null,
        deviceToken: deviceToken ?? undefined,
        userAgent: request.headers.get("user-agent"),
        // The multi-business path spends an already-proven code, so the trust
        // choice travels with the request exactly as it does on the direct one.
        wantsTrust: body.trustDevice === true,
        trustedDeviceToken: readTrustedDeviceToken(request),
      });
    });
  }

  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  /**
   * Issue #854 (P1.18) — the multi-business path.
   *
   * A number that matched members in several businesses was sent a code under a
   * challenge keyed on the *number* (`phoneDerivedSubject`), and nothing about
   * those businesses was revealed. The code is verified here; only a successful
   * proof produces the list, together with a short-lived selection token so the
   * member can name the business without being asked for another code.
   */
  if (payload.multiBusiness && payload.candidatePhone) {
    const candidate = payload.candidatePhone;
    return withoutTenantScope("login", async () => {
      const subject = await phoneDerivedSubject(candidate);
      const redeemed = await redeemOtpChallenge({
        subjectRealm: PENDING_PHONE_REALM,
        subjectId: subject,
        purpose: "login",
        code,
        expectedPhoneE164: candidate,
      });
      if (!redeemed.ok) {
        return NextResponse.json({ error: "invalid_code" }, { status: 401 });
      }

      const { rows } = await query<{
        id: string;
        business_id: string;
        business_name: string;
      }>(
        `SELECT u.id, u.business_id, b.name AS business_name
           FROM users u
           JOIN businesses b ON b.id = u.business_id
          WHERE u.phone_e164 = $1 AND u.is_active
            AND u.phone_verified_at IS NOT NULL
            AND b.status = 'active'`,
        [candidate],
      );

      const [first] = rows;
      if (!first) {
        return NextResponse.json({ error: "invalid_code" }, { status: 401 });
      }

      const selectionToken = await signPhonePendingToken({
        sub: null,
        businessId: "00000000-0000-0000-0000-000000000000",
        mayAttachPhone: false,
        phone: null,
        candidatePhone: candidate,
        multiBusiness: true,
        otpProven: true,
      });

      return NextResponse.json({
        needsBusinessSelection: true,
        businesses: rows.map((row) => ({ id: row.business_id, name: row.business_name })),
        selectionToken,
      });
    });
  }

  /**
   * The anti-enumeration token from a number nothing matched: no subject, no
   * challenge, and the only honest answer is the one a wrong code gets.
   */
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

    /**
     * Issue #854 (P0.8 / P1.17): the challenge is redeemed by purpose — this
     * door only accepts a `login`/`verify_login_phone` code — and the candidate
     * phone comes from the challenge row, never from this request body.
     */
    const purpose = payload.phone
      ? "change_login_phone"
      : payload.mayAttachPhone
        ? "verify_login_phone"
        : "login";
    const ok = await verifyEmployeePhoneOtp({
      userId: payload.sub!,
      code,
      purpose,
      expectedPhoneE164: payload.phone ?? null,
    });
    if (!ok) {
      await auditLoginFailure(payload.businessId, payload.sub!, "invalid_phone_otp");
      return NextResponse.json({ error: "invalid_code" }, { status: 401 });
    }

    const { rows } = await query<MemberRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id,
              u.role, u.full_name, u.phone_e164, u.platform_user_id,
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

    return completePhoneLogin(member, {
      /**
       * The number to *attach* — only ever the candidate this pending token
       * explicitly names, so a body field cannot redirect the write.
       */
      attachPhone: payload.mayAttachPhone ? (payload.phone ?? null) : null,
      deviceToken: deviceToken ?? undefined,
      userAgent: request.headers.get("user-agent"),
      wantsTrust: body.trustDevice === true,
      trustedDeviceToken: readTrustedDeviceToken(request),
    });
  });
}

/**
 * Issue #854 (P0.7) — the terminal step of a phone-OTP login: MFA policy, the
 * verification stamps, the session.
 *
 * Extracted so both entrances reach it — the single-business flow above and the
 * post-selection step of the multi-business flow — and neither can forget the
 * ordering that fixed P0.7: **the stamps commit only after every required
 * challenge has passed.** `stampPhoneVerified` writes `phone_verified_at` *and*
 * `otp_login_at`, and `otp_login_at` is what opens the 7-day window in which the
 * PIN door mints a session without any OTP. Stamping before the MFA branch made
 * this chain mechanical:
 *
 *     Owner/Manager → phone OTP succeeds → TOTP step appears
 *     → user cancels → otp_login_at already updated
 *     → PIN login succeeds → privileged session without the second factor
 *
 * The pending token stays valid for its ten minutes, so an interrupted member
 * can resume; they simply do not get credit for a ceremony they did not finish.
 */

    /**
     * Issue #854 (P0.7) — **nothing is stamped until the whole authentication
     * transaction has succeeded.**
     *
     * `stampPhoneVerified` writes `phone_verified_at` *and* `otp_login_at`, and
     * `otp_login_at` is what opens the 7-day window in which the PIN door mints
     * a session without any OTP. Stamping it here — before the MFA branch — made
     * the exploit chain mechanical:
     *
     *     Owner/Manager → phone OTP succeeds → TOTP step appears
     *     → user cancels → otp_login_at already updated
     *     → PIN login succeeds → privileged session without the second factor
     *
     * So the stamp moves to the end of this handler, after every required step
     * has passed. The pending token stays valid for its ten minutes, so a member
     * who is interrupted can resume; they simply do not get credit for a
     * ceremony they did not finish.
     */
async function completePhoneLogin(
  member: MemberRow,
  options: {
    attachPhone: string | null;
    deviceToken?: string;
    userAgent: string | null;
    /** The member ticked «اعتماد به این دستگاه برای ۷ روز» on this request. */
    wantsTrust?: boolean;
    /** The trusted-device cookie the browser arrived with, if any. */
    trustedDeviceToken?: string | null;
  },
): Promise<NextResponse> {
    // Issue #885, gap 3 — set only when a due MFA challenge was waived because
    // this device already held trust. Load-bearing below: trust is earned by
    // *completing* every factor, never by being exempted from one.
    let mfaWaivedByTrust = false;

    const stamp = () =>
      stampPhoneVerified({
        businessId: member.business_id,
        userId: member.id,
        phone: options.attachPhone ?? null,
      });

    let graceNotice: {
      mfaState: "grace";
      graceUntil: string | null;
      graceDaysLeft: number | null;
    } | null = null;

    if (member.platform_user_id) {
      const mfaPolicy = await getMfaPolicy(member.business_id);
      const requiresMfa = mfaAppliesToRole(member.role, mfaPolicy);
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

        const challengeDue = shouldChallengeMfaOnLogin({
          hasConfirmedEnrolment: activeEnrolments.length > 0,
          appliesToRole: requiresMfa,
          requirement: req,
        });

        /*
         * Issue #885, gap 3 — a device this member already trusted skips the
         * *routine* second-factor challenge, and only that.
         *
         * What this deliberately does not do:
         *  - it does not substitute for the primary factor. The OTP was
         *    redeemed above, before this line, so possession of the number is
         *    already proven;
         *  - it does not satisfy the distinct-factor rule. A waived challenge
         *    is not a completed second factor, so nothing downstream may count
         *    it as one;
         *  - it does not cover step-up for sensitive actions, which is a
         *    separate `requireRecentAuth` check on the routes that need it.
         *
         * Scoped to this business and this membership, and consulted only when
         * a challenge is actually due — otherwise it is a query for nothing.
         */
        const deviceTrust = challengeDue
          ? await verifyTrustedDevice({
              businessId: member.business_id,
              userId: member.id,
              token: options.trustedDeviceToken ?? null,
            })
          : null;
        mfaWaivedByTrust = challengeDue && deviceTrust?.trusted === true;

        if (challengeDue && !mfaWaivedByTrust) {
          const mfaToken = await signMfaPendingToken({
            sub: member.platform_user_id,
            method: distinctMethods[0] ?? null,
            authRealm: "tenant_password",
            businessId: member.business_id,
            primaryAuth: "phone_otp",
            /**
             * Issue #854 (GAP 8) — the verified completion context rides the
             * signed token. `/api/auth/mfa/verify` commits the deferred stamps
             * from these fields alone (never from the request body), and only
             * after the second factor passes; an abandoned ceremony therefore
             * still commits nothing.
             */
            phoneCompletion: {
              membershipId: member.id,
              provenPhone: options.attachPhone ?? member.phone_e164,
              attachPhone: options.attachPhone,
            },
          });

          return NextResponse.json({
            mfaRequired: true,
            mfaState: req,
            mfaToken,
            mfaMethod: distinctMethods[0] ?? null,
            availableMethods: distinctMethods,
            primaryAuth: "phone_otp",
            /*
             * Issue #885 — the ceremony is not over, so no trust is granted
             * here. The choice is echoed back so the MFA step can carry the
             * member's intent forward and register it only if that last factor
             * actually completes.
             */
            ...(options.wantsTrust ? { trustOffered: true } : {}),
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

    // The ceremony is complete: no further challenge can be pending, so the
    // verification stamps commit now (issue #854 P0.7).
    await stamp();

    await ensureEmployeeProfile(member.id, member.business_id);
    const deviceLabel = options.userAgent?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(options.deviceToken, member.business_id);
    const { session: employeeSession } = await createSession(member.id, member.business_id, {
      locationId: member.location_id,
      deviceLabel,
      deviceId,
      loginMethod: "phone_otp",
      userAgent: options.userAgent ?? null,
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

    /*
     * Issue #885 — the seven-day device trust the member asked for.
     *
     * Reached only here, at the end of a ceremony in which every required
     * factor actually passed. Two guards are load-bearing:
     *
     *  - `!mfaWaivedByTrust`: trust is earned by *completing* every factor,
     *    not by being exempted from one. If a waived MFA could re-mint trust,
     *    a device would extend its own window indefinitely on ordinary logins
     *    and the seven-day expiry would never bite.
     *  - the `.catch`: the login itself is already complete and must not fail
     *    because a convenience row could not be written.
     */
    if (options.wantsTrust && !mfaWaivedByTrust) {
      const trust = await issueTrustedDevice({
        businessId: member.business_id,
        userId: member.id,
        platformUserId: member.platform_user_id,
        deviceToken: options.deviceToken,
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
}
