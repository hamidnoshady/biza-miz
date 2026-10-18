import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { toLatinDigits } from "@/lib/digits";
import { resolveDeviceId } from "@/lib/device-service";
import { requestHost } from "@/lib/host";
import {
  auditLoginFailure,
  checkLoginLockout,
  createSession,
  ensureEmployeeProfile,
  resolveLoginBusinessId,
} from "@/lib/employee-service";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/team";
import {
  maskPhoneE164,
  phoneOtpEnforcementFor,
  signPhonePendingToken,
} from "@/lib/phone-otp";
import { memberPhoneState, pinGateCloses } from "@/lib/phone-otp-policy";
import {
  auditTrustedDeviceLogin,
  readTrustedDeviceToken,
  verifyTrustedDevice,
} from "@/lib/trusted-device";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { pinEligibleRolesSql } from "@/lib/login-eligibility";
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
  pin_hash: string | null;
  platform_user_id: string | null;
  token_version: number | null;
  phone_e164: string | null;
  phone_verified_at: Date | null;
}

/**
 * PIN quick-login for Cashier/Waiter/Kitchen.
 *
 * The member is named first (`pin-login/roster`, Phase 20 Wave 2), and the
 * PIN is checked against that one member only. A PIN is a personal secret,
 * not an identifier: two members may choose the same digits (migration 0221
 * dropped the per-business uniqueness that the old PIN-only scan needed,
 * because refusing a duplicate told the person choosing it what a colleague's
 * PIN was). So a request without `employeeId` is refused rather than scanned.
 * A successful match also mints a server-side `employee_sessions` row
 * (Wave 1) *alongside* the existing JWT — the JWT stays the bearer credential
 * in the cookie, the DB row exists so the session can be listed/revoked and
 * so a revocation takes effect immediately (see checkEmployeeSession in
 * auth.ts) rather than waiting for the JWT's own expiry.
 *
 * Phase 42 — the PIN is no longer the whole story. Once the business's
 * phone-OTP adoption window has closed (`auth.phoneOtp`, see
 * phone-otp-policy.ts), a correct PIN alone does not mint a session: the
 * member must also hold a verified phone number and have verified by OTP
 * within the last 7 days. Outside that window the response carries a
 * ten-minute `phone_pending` token instead of a cookie, and the client walks
 * the member through the OTP step (`/api/auth/phone-otp/*`); the very same
 * response shape is used *inside* the window when the member asked to verify
 * their number proactively (`verifyPhone: true` — the door's «تأیید شمارهٔ
 * موبایل» button), which is how staff spend the 14-day adoption window
 * without an OTP being forced on them yet.
 */
export async function POST(request: NextRequest) {
  let body: {
    pin?: string;
    employeeId?: string;
    locationId?: string;
    businessId?: string;
    businessSlug?: string;
    deviceToken?: string;
    verifyPhone?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pin = body.pin ? toLatinDigits(String(body.pin)) : "";
  if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin)) {
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }
  const employeeId = typeof body.employeeId === "string" ? body.employeeId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employeeId)) {
    return NextResponse.json({ error: "employee_required" }, { status: 400 });
  }

  const { businessId, error } = await resolveLoginBusinessId({
    ...body,
    host: requestHost(request.headers),
  });
  if (!businessId) {
    // "Which business?" is a configuration problem, not a credential one, so
    // it gets a 400 the device can act on rather than a blanket 401.
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const deployment = await readDeploymentProfile(businessId);
    // Issue #885 L13 — the roles a PIN door accepts are one policy, not a
    // literal repeated at each door. Cloud: staff only, because the
    // privileged roles have a platform account and sign in with a password.
    // Local/hybrid: both sets, since a standalone install has nothing else to
    // offer an owner standing at the till.
    const pinEligibleRoles = pinEligibleRolesSql(deployment.profile);
    // Phase 20 Wave 8 — the request names the employee, so a lockout is
    // checked before touching the PIN at all.
    const lockout = await checkLoginLockout(businessId, employeeId);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    // RLS confines this to `businessId`, which is why there is no business_id
    // predicate here — the tenant scope is the boundary being relied on.
    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id,
              u.role, u.full_name, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
              u.platform_user_id, p.token_version,
              u.phone_e164, u.phone_verified_at, u.otp_login_at
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
         LEFT JOIN LATERAL (
           SELECT secret_hash FROM employee_credentials
            WHERE employee_id = u.id AND business_id = u.business_id
              AND credential_type = 'pin' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
         ) ec ON true
        WHERE u.is_active
          AND u.role IN ${pinEligibleRoles}
          AND coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL
          AND u.id = $1`,
      [employeeId],
    );

    const candidate = rows[0];
    const user =
      candidate?.pin_hash && (await bcrypt.compare(pin, candidate.pin_hash))
        ? candidate
        : undefined;

    if (!user) {
      // Phase 20 Wave 7 — visible in the new security center even though no
      // one is authenticated yet; entity_id is the attempted employeeId.
      await auditLoginFailure(businessId, employeeId, "invalid_pin");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    // -----------------------------------------------------------------------
    // Phase 42 — the phone-OTP gate. Evaluated only *after* the PIN has
    // proved who is asking, so a wrong PIN never reveals which step would
    // have come next.
    // -----------------------------------------------------------------------
    const enforcement = await phoneOtpEnforcementFor(user.business_id);
    const phoneState = memberPhoneState(user.phone_e164, user.phone_verified_at);

    // The member asked to verify their number this time (the door's optional
    // button, spent during the adoption window). Honour it whenever an OTP
    // can actually be delivered and there is something to verify — a verified
    // number this device is already trusted for has nothing to do.
    const wantsVerification =
      body.verifyPhone === true &&
      phoneState !== "verified" &&
      (enforcement.state === "grace" || enforcement.state === "enforced");

    // -----------------------------------------------------------------------
    // Issue #885 — the seven-day trusted-device exemption.
    //
    // This waives the *routine* re-verification, nothing else. The PIN above
    // is still an approved primary credential and was still just proven; the
    // membership, its business and its lockout were still re-read; and
    // `authorize` still decides everything the session can do afterwards.
    // What changes is that a device which completed a full verification and
    // was explicitly trusted inside the last seven days is not asked to
    // verify again.
    //
    // The lookup is scoped to this business *and* this member *and* the
    // presenting device cookie, so a second device that this membership
    // signs in from is a miss and is challenged in full — even one minute
    // after the first device verified. That is the whole point of the scope:
    // `users.otp_login_at` is member-wide, and reading it here would let one
    // verified phone exempt every till in the shop. It is deliberately *not*
    // consulted for this decision.
    //
    // Trust is also only ever minted by a completed verification
    // (mfa/verify, phone-otp/verify), never by an ordinary login, so taking
    // the exempt path here cannot lengthen it; an expired or revoked row
    // reads as a miss and the gate shuts again.
    //
    // Only consulted while the policy is enforced. Before the adoption date
    // there is no challenge to waive, and asking the table anyway would be a
    // query per login for nothing.
    const deviceTrust =
      enforcement.state === "enforced"
        ? await verifyTrustedDevice({
            businessId: user.business_id,
            userId: user.id,
            token: readTrustedDeviceToken(request),
          })
        : null;
    const trustExempt = deviceTrust?.trusted === true;

    // Hard gate: past the adoption date (and with SMS configured), the PIN
    // alone opens the door only for a device this member has trusted inside
    // the last seven days *and* still has a verified number behind it.
    // Revoking the trust, letting it lapse, or losing the verified number
    // each re-arms the challenge on their own. The rule itself is shared with
    // the roster's routing hint so the two can never disagree.
    const gateClosed = pinGateCloses({
      enforcement: enforcement.state,
      phoneState,
      deviceTrusted: trustExempt,
    });

    // A member who *asked* to verify their number still gets to, trusted
    // device or not — that is the door's optional button, and honouring it is
    // how a number gets onto file in the first place.
    if (wantsVerification || gateClosed) {
      // The PIN was proven — the member may set a number that is not on file
      // yet; every other path through the phone-OTP door may only be sent to
      // a number already stored.
      const phoneToken = await signPhonePendingToken({
        sub: user.id,
        businessId: user.business_id,
        mayAttachPhone: true,
        phone: null,
      });
      return NextResponse.json({
        // `set_phone` — nothing on file: the client asks for the number
        // first. `otp` — a number is stored (verified with a closed window,
        // or stored-but-unverified): straight to the code entry.
        phoneVerification: phoneState === "none" ? "set_phone" : "otp",
        phoneState,
        maskedPhone: user.phone_e164 ? maskPhoneE164(user.phone_e164) : null,
        phoneToken,
        user: { id: user.id, role: user.role, fullName: user.full_name },
      });
    }

    // -----------------------------------------------------------------------
    // Issue #854 (P0.6) — a privileged role must not skip MFA through the PIN
    // door.
    //
    // The fast staff door admits `cashier`/`waiter`/`kitchen` — and, on a
    // Local/Hybrid install, `owner`/`admin`/`manager`/`accountant`. A privileged
    // role let through here *without* the password path's second-factor policy
    // is the bypass the finding describes: pick your own name on the till and
    // walk in as the owner. The policy is asked through the same predicate the
    // password and phone-OTP doors use, so "MFA applies consistently across
    // every login path" is enforced rather than asserted.
    //
    // The preferred fix from the issue is the strict one: a role that requires
    // a second factor does not get to use the PIN door at all. It is refused
    // with `mfa_required` and the client sends the member to the account door.
    // (A PIN factor is device-local and cannot stand in for a global factor,
    // and allowing "PIN then TOTP" would reintroduce the same ordering problem
    // the phone-OTP path had.) A privileged role that does **not** require a
    // factor — an accountant on a business that has not opted in — keeps the
    // quick door, which is what the deployment profile was asking for.
    // -----------------------------------------------------------------------
    if (isPrivilegedMfaRole(user.role)) {
      const mfaPolicy = await getMfaPolicy(user.business_id);
      const requiresMfa = mfaAppliesToRole(user.role, mfaPolicy);
      const enrolments = user.platform_user_id
        ? filterActiveMfaEnrolments(
            await getAccountMfaEnrolments("platform_user", user.platform_user_id),
          )
        : [];

      if (requiresMfa || enrolments.length > 0) {
        await auditLoginFailure(user.business_id, user.id, "privileged_pin_mfa_required");
        return NextResponse.json(
          {
            error: "mfa_required",
            message:
              "برای این نقش ورود دومرحله‌ای لازم است؛ از درِ ورود حساب کاربری استفاده کنید.",
            role: user.role,
          },
          { status: 403 },
        );
      }
    }

    // The trust only mattered if the gate would otherwise have shut; record
    // that case before the session exists, so it cannot be minted unlogged.
    if (
      deviceTrust?.trusted === true &&
      pinGateCloses({ enforcement: enforcement.state, phoneState, deviceTrusted: false })
    ) {
      await auditTrustedDeviceLogin({
        businessId: user.business_id,
        userId: user.id,
        platformUserId: user.platform_user_id,
        door: "pin",
        waived: "phone_otp",
        expiresAt: deviceTrust.expiresAt,
      });
    }

    await ensureEmployeeProfile(user.id, user.business_id);
    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, user.business_id);
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
      deviceLabel,
      deviceId,
      loginMethod: "pin",
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
      /**
       * Issue #854 (P0.6): the member's real global identity, not `null`.
       *
       * The old session hard-coded `platformUserId: null` even for a member who
       * plainly had one, which meant the session did not participate in global
       * identity revocation — a password change or "sign out everywhere" on the
       * cloud could not reach a PIN session minted here, because nothing tied
       * the two together. Carrying the id (and the identity's `tokenVersion`,
       * which `auth.ts` re-checks live) puts the PIN door inside the same
       * revocation boundary as every other door.
       */
      platformUserId: user.platform_user_id,
      tokenVersion: user.token_version ?? undefined,
      employeeSessionId: employeeSession.id,
      recentAuthAt: Math.floor(Date.now() / 1000),
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
      // Inside the adoption window the session mints as before, but the door
      // tells the member their number is still missing/unproven and how many
      // days the window has left — the client renders it as a hint, not a
      // gate. Deliberately omitted once the state is `enforced` (nothing left
      // to count down to) and `pending_sms` (the countdown is frozen until an
      // SMS provider is configured — showing a shrinking number that never
      // bites would be a lie).
      ...(enforcement.state === "grace" && phoneState !== "verified"
        ? {
            phoneOtp: {
              state: enforcement.state,
              daysLeft: enforcement.daysLeft,
              phoneState,
            },
          }
        : {}),
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
