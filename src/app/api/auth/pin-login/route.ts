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
import { memberPhoneState, pinWindowActive } from "@/lib/phone-otp-policy";
import { readTrustedDeviceToken, verifyTrustedDevice } from "@/lib/trusted-device";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { pinEligibleRolesSql } from "@/lib/login-eligibility";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  pin_hash: string | null;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  otp_login_at: Date | null;
}

/**
 * PIN quick-login for Cashier/Waiter/Kitchen.
 *
 * PINs are unique per business (migration 0020 moved that uniqueness down from
 * the whole table), so (business, pin) identifies one member; passing a
 * locationId narrows it further on a multi-branch business.
 *
 * Phase 20 Wave 2 — the redesigned login picks an employee by name first
 * (`pin-login/roster`), so `employeeId` narrows the lookup to that one row
 * instead of scanning every PIN-role member; omitting it keeps the original
 * bcrypt-scan behaviour for any caller that still only sends a PIN. Either
 * way, a successful match also mints a server-side `employee_sessions` row
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
    // Phase 20 Wave 8 — a picker-narrowed request already names the employee,
    // so a lockout is checked before touching the PIN at all; a bare legacy
    // scan doesn't know who it is yet and gets the same check further below,
    // once the matching row (if any) is found.
    if (body.employeeId) {
      const lockout = await checkLoginLockout(businessId, body.employeeId);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }
    }

    const params: unknown[] = [];
    let filter = "";
    if (body.employeeId) {
      params.push(body.employeeId);
      filter = "AND u.id = $1";
    } else if (body.locationId) {
      params.push(body.locationId);
      filter = "AND u.location_id = $1";
    }

    // RLS confines this to `businessId`, which is why there is no business_id
    // predicate here — the tenant scope is the boundary being relied on.
    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, u.location_id,
              u.role, u.full_name, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash,
              u.phone_e164, u.phone_verified_at, u.otp_login_at
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         LEFT JOIN LATERAL (
           SELECT secret_hash FROM employee_credentials
            WHERE employee_id = u.id AND business_id = u.business_id
              AND credential_type = 'pin' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
         ) ec ON true
        WHERE u.is_active
          AND u.role IN ${pinEligibleRoles}
          AND coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL
          ${filter}`,
      params,
    );

    let user: UserRow | undefined;
    for (const row of rows) {
      if (row.pin_hash && (await bcrypt.compare(pin, row.pin_hash))) {
        user = row;
        break;
      }
    }

    if (!user) {
      // Phase 20 Wave 7 — visible in the new security center even though no
      // one is authenticated yet; entity_id is the attempted employeeId when
      // the Wave 2 picker narrowed the request, null for a bare legacy scan.
      await auditLoginFailure(businessId, body.employeeId ?? null, "invalid_pin");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    // Phase 20 Wave 8 — the employeeId branch above already checked; only a
    // bare legacy scan reaches here without having checked yet, since it only
    // learns who matched by finding the right PIN.
    if (!body.employeeId) {
      const lockout = await checkLoginLockout(businessId, user.id);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Phase 42 — the phone-OTP gate. Evaluated only *after* the PIN has
    // proved who is asking, so a wrong PIN never reveals which step would
    // have come next.
    // -----------------------------------------------------------------------
    const enforcement = await phoneOtpEnforcementFor(user.business_id);
    const phoneState = memberPhoneState(user.phone_e164, user.phone_verified_at);
    const windowActive = pinWindowActive(user.otp_login_at);

    // The member asked to verify their number this time (the door's optional
    // button, spent during the adoption window). Honour it whenever an OTP
    // can actually be delivered and there is something to verify — a verified
    // number inside an open window has nothing to do.
    const wantsVerification =
      body.verifyPhone === true &&
      phoneState !== "verified" &&
      (enforcement.state === "grace" || enforcement.state === "enforced");

    // Hard gate: past the adoption date (and with SMS configured), the PIN
    // alone only opens the door inside the 7-day OTP window.
    const gateClosed =
      enforcement.state === "enforced" && !(phoneState === "verified" && windowActive);

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
    // The lookup is scoped to this business *and* this member, so the
    // membership-wide `otp_login_at` window it supplements cannot do what the
    // policy forbids: one verified phone exempting every device that
    // membership signs in from. A different device, a different account or a
    // different tenant is a miss, and the gate below closes as usual.
    //
    // Only consulted when the gate would otherwise shut. On an install where
    // the policy is not enforced there is no challenge to waive, and asking
    // the table anyway would be a query per login for nothing.
    const deviceTrust = gateClosed
      ? await verifyTrustedDevice({
          businessId: user.business_id,
          userId: user.id,
          token: readTrustedDeviceToken(request),
        })
      : null;
    const trustExempt = deviceTrust?.trusted === true;

    // A member who *asked* to verify their number still gets to, trusted
    // device or not — that is the door's optional button, and honouring it is
    // how a number gets onto file in the first place.
    if (wantsVerification || (gateClosed && !trustExempt)) {
      // The PIN was proven — the member may set a number that is not on file
      // yet; every other path through the phone-OTP door may only be sent to
      // a number already stored.
      const phoneToken = await signPhonePendingToken({
        sub: user.id,
        businessId: user.business_id,
        mayAttachPhone: true,
        phone: null,
        // No challenge yet: this token authorises a *send*. The request route
        // mints the challenge and re-signs a token that names it, so the
        // binding required at verify time is established by the send that
        // actually happened rather than promised up front here.
        cid: null,
        destination: null,
        purpose: "attach",
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

    await ensureEmployeeProfile(user.id, user.business_id);
    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, user.business_id);
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
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
