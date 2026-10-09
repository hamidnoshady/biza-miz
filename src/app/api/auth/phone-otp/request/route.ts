import { NextRequest, NextResponse } from "next/server";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { requestHost } from "@/lib/host";
import { checkLoginLockout, resolveLoginBusinessId } from "@/lib/employee-service";
import { boundedString, uuidOrNull } from "@/lib/login-contract";
import {
  canonicalMemberPhone,
  maskPhoneE164,
  sendEmployeePhoneOtp,
  signPhonePendingToken,
  verifyPhonePendingToken,
  type PhoneOtpPurpose,
} from "@/lib/phone-otp";
import { KavenegarError } from "@/lib/sms-kavenegar";

interface MemberRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  phone_e164: string | null;
}

/**
 * Phase 42 — start a phone-OTP login: mint the challenge and dispatch the
 * code through Kavenegar. One route, three ways in, and the difference
 * between them is exactly how much has been proven:
 *
 *  1. **Bearer `phone_pending` token** (the PIN-verified step of
 *     `/api/auth/pin-login`) — the member's PIN is proven, so a *new* number
 *     may be attached (first-time verify: nothing on file yet) or the stored
 *     number may be (re)verified.
 *  2. **`employeeId`** (a name picked from the roster, no PIN) — only the
 *     number already on file may be challenged; the OTP itself is the
 *     credential, so "pick a name, type any number" must not be possible.
 *  3. **`phone`** (the door's «ورود با شمارهٔ موبایل» tab) — resolves the
 *     member by number; only a *verified* number can log in, because an
 *     owner-typed-but-unproven number must never become a login credential
 *     by itself.
 *
 * Case 3 answers a number that matches nothing exactly as it answers one
 * that does (a token whose verify can never succeed, no SMS sent) — a door
 * that reads "wrong number" out loud is a free member-number oracle, and the
 * roster already publishes enough names as it is.
 *
 * Issue #885:
 *
 *  - **L01** — this route and its `/verify` twin are pre-session by
 *    definition; the whole point of the door is that nobody is signed in yet.
 *    They were listed in the middleware's rate-limit paths but not in
 *    `PUBLIC_PATHS`, so `handleTenantAuth` answered 401 before the handler
 *    ran and the form showed «مهلت این مرحله تمام شده است» for a number that
 *    had simply never been valid. They are public now, with their own
 *    credential checks and their own limits; the *authenticated* phone
 *    self-service routes (`/api/auth/phone/self`) stay gated.
 *  - **L02** — the send happens *before* the token is signed, so the token
 *    can carry the id of the exact challenge it may be redeemed against,
 *    plus the number it was sent to and what it is proving. Signing first
 *    (the old order) left the token naming nothing, and verification fell
 *    back to "newest challenge for this member" — which any concurrent
 *    ceremony for the same member could satisfy.
 *  - **L15** — on the direct-phone path every failure now collapses to the
 *    same synthetic success. A known-but-locked member used to get 423, a
 *    rate-limited one 429 and an SMS outage 502, which between them answered
 *    "this number is on file" for free. The roster and PIN-proven paths keep
 *    their specific errors, because there the member is already identified by
 *    something they proved.
 */
export async function POST(request: NextRequest) {
  let body: {
    employeeId?: unknown;
    phone?: unknown;
    businessId?: unknown;
    businessSlug?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Issue #885 L14 — bounded runtime validation before anything reaches a
  // database or a crypto call. A truthy non-string here used to arrive at
  // `canonicalMemberPhone` and `resolveLoginBusinessId` as an object.
  const employeeId = uuidOrNull(body.employeeId);
  const rawPhone = boundedString(body.phone, { max: 32, required: false });
  const businessIdHint = uuidOrNull(body.businessId);
  const businessSlug = boundedString(body.businessSlug, { max: 120, required: false });
  const business = businessIdHint
    ? { businessId: businessIdHint }
    : businessSlug
      ? { businessSlug }
      : {};

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  // ------------------------------------------------------------------ 1. PIN-verified continuation
  if (bearer) {
    const payload = await verifyPhonePendingToken(bearer);
    if (!payload?.sub) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return withTenant(payload.businessId, async () => {
      const lockout = await checkLoginLockout(payload.businessId!, payload.sub!);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE id = $1 AND business_id = $2 AND is_active`,
        [payload.sub, payload.businessId],
      );
      const member = rows[0];
      if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

      let phone: string | null = member.phone_e164;
      if (payload.mayAttachPhone && rawPhone) {
        const candidate = canonicalMemberPhone(rawPhone);
        if (!candidate) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        // A candidate typed at this step still needs the OTP below to stick;
        // storing it happens in verify, not here.
        phone = candidate;
      }
      if (!phone) return NextResponse.json({ error: "phone_missing" }, { status: 400 });

      return dispatchOrError({
        businessId: payload.businessId!,
        userId: member.id,
        phone,
        mayAttachPhone: payload.mayAttachPhone,
        // Only a number that is not already on file needs attaching; verify
        // writes it. Sending it when it equals the stored one would make
        // `stampPhoneVerified` rewrite a column that was already correct.
        attachPhone: phone !== member.phone_e164 ? phone : null,
      });
    });
  }

  // ------------------------------------------------------------------ 2. roster pick → stored number
  if (employeeId) {
    const { businessId, error } = await resolveLoginBusinessId({
      ...business,
      host: requestHost(request.headers),
    });
    if (!businessId) {
      return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
    }

    return withTenant(businessId, async () => {
      const lockout = await checkLoginLockout(businessId, employeeId);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE id = $1 AND business_id = $2 AND is_active`,
        [employeeId, businessId],
      );
      const member = rows[0];
      if (!member) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
      if (!member.phone_e164) {
        return NextResponse.json({ error: "phone_missing" }, { status: 400 });
      }

      return dispatchOrError({
        businessId,
        userId: member.id,
        phone: member.phone_e164,
        mayAttachPhone: false,
      });
    });
  }

  // ------------------------------------------------------------------ 3. direct phone login
  const phone = canonicalMemberPhone(rawPhone);
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });

  const { businessId, error } = await resolveLoginBusinessId({
    ...business,
    host: requestHost(request.headers),
  });

  if (businessId) {
    return withTenant(businessId, async () => {
      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE business_id = $1 AND phone_e164 = $2 AND is_active
            AND phone_verified_at IS NOT NULL`,
        [businessId, phone],
      );
      const member = rows[0];
      if (!member) return antiEnumerationResponse(phone);

      const lockout = await checkLoginLockout(businessId, member.id);
      if (lockout.locked) {
        // L15: a locked account and an unknown number must be the same
        // answer. The member is already proved to exist by nothing here —
        // only by having this number, which is exactly the fact being tested.
        return antiEnumerationResponse(phone);
      }

      return dispatchOrError({
        businessId,
        userId: member.id,
        phone,
        mayAttachPhone: false,
        suppressDiagnostics: true,
      });
    });
  }

  // No origin named a business (a single-box install without host routing).
  // The number itself may still name exactly one member — the password login's
  // `needsBusinessSelection` shape, answered for a phone. Cross-tenant by
  // nature, like /api/auth/login, and on the same documented bypass.
  //
  // Retained deliberately, with the disclosure it implies: on an install with
  // no host routing every business belongs to the operator running it, and
  // there is no tenant boundary here to leak across. A multi-tenant cloud
  // host always resolves a business, so it never reaches this branch.
  if (error === "business_required") {
    return withoutTenantScope("login", async () => {
      const { rows } = await query<{ id: string; full_name: string; business_id: string; business_name: string }>(
        `SELECT u.id, u.full_name, u.business_id, b.name AS business_name
           FROM users u
           JOIN businesses b ON b.id = u.business_id
          WHERE u.phone_e164 = $1 AND u.is_active
            AND u.phone_verified_at IS NOT NULL
            AND b.status = 'active'`,
        [phone],
      );
      if (rows.length === 0) return antiEnumerationResponse(phone);
      if (rows.length > 1) {
        return NextResponse.json({
          needsBusinessSelection: true,
          businesses: rows.map((r) => ({ id: r.business_id, name: r.business_name })),
        });
      }
      const member = rows[0];
      return dispatchOrError({
        businessId: member.business_id,
        userId: member.id,
        phone,
        mayAttachPhone: false,
        suppressDiagnostics: true,
      });
    });
  }

  return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
}

/**
 * Send the code, then sign the token that is allowed to redeem it.
 *
 * The order is the fix for issue #885 L02: the challenge row has to exist
 * before the pending token can name it, so the send comes first and the token
 * is minted from what the send actually produced — its id, the number it went
 * to, and what it is being asked to prove. A caller therefore cannot end up
 * holding a token bound to a challenge that was never issued.
 *
 * Shared by all three modes so the Kavenegar user-fault/operator-fault split
 * (see the challenge route's twin comment) is decided in exactly one place.
 */
async function dispatchOrError(options: {
  businessId: string;
  userId: string;
  phone: string;
  mayAttachPhone: boolean;
  /**
   * The candidate number a PIN-verified member typed at the attach step, when
   * it is not the one already on file. Carried on the token so `verify` can
   * write it once the code proves ownership; null everywhere else.
   */
  attachPhone?: string | null;
  /**
   * Collapse every failure into the anti-enumeration shape. Set on the
   * direct-phone path, where nothing has been proven yet; unset on the roster
   * and PIN-proven paths, where the member is already identified and a
   * specific error costs nothing.
   */
  suppressDiagnostics?: boolean;
}): Promise<NextResponse> {
  // `attach` when the proof is going to write a number to the membership,
  // `login` when the number on file is itself the credential. Derived from
  // the token's own claim so the request and verify halves cannot disagree
  // about which ceremony this is.
  const purpose: PhoneOtpPurpose = options.mayAttachPhone ? "attach" : "login";

  let challengeId = "";
  try {
    const sent = await sendEmployeePhoneOtp({
      businessId: options.businessId,
      userId: options.userId,
      phone: options.phone,
      purpose,
    });
    if (!sent.allowed) {
      if (options.suppressDiagnostics) return antiEnumerationResponse(options.phone);
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
        { status: 429 },
      );
    }
    challengeId = sent.challengeId;
  } catch (err) {
    console.error("Phone-OTP dispatch failed", err);
    if (options.suppressDiagnostics) return antiEnumerationResponse(options.phone);
    // Only the half of a Kavenegar failure the member can *act on* is theirs
    // to see; an operator-side fault (empty credit, bad key) stays generic so
    // the member is not sent re-typing a number that was never the problem.
    const message =
      err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
    return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
  }

  const token = await signPhonePendingToken({
    sub: options.userId,
    businessId: options.businessId,
    mayAttachPhone: options.mayAttachPhone,
    phone: options.attachPhone ?? null,
    cid: challengeId,
    destination: options.phone,
    purpose,
  });

  return NextResponse.json({
    status: "sent",
    maskedPhone: maskPhoneE164(options.phone),
    token,
  });
}

/**
 * The answer to a number nothing matched: byte-identical to success minus a
 * code ever being sent. The token carries no subject, so its verify can only
 * ever say «کد درست نیست» — the shape holds, the oracle doesn't.
 */
async function antiEnumerationResponse(phone: string): Promise<NextResponse> {
  const token = await signPhonePendingToken({
    sub: null,
    businessId: "00000000-0000-0000-0000-000000000000",
    mayAttachPhone: false,
    phone: null,
    cid: null,
    destination: null,
    purpose: "login",
  });
  return NextResponse.json({ status: "sent", maskedPhone: maskPhoneE164(phone), token });
}
