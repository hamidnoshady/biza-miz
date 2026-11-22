import { NextRequest, NextResponse } from "next/server";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { requestHost } from "@/lib/host";
import { checkLoginLockout, resolveLoginBusinessId } from "@/lib/employee-service";
import {
  PENDING_PHONE_REALM,
  canonicalMemberPhone,
  checkPhoneOtpRateLimit,
  maskPhoneE164,
  sendEmployeePhoneOtp,
  signPhonePendingToken,
  verifyPhonePendingToken,
} from "@/lib/phone-otp";
import { KavenegarError } from "@/lib/sms-kavenegar";
import { getSmsProvider } from "@/lib/sms-config";
import {
  consumeAllChallenges,
  issueOtpChallenge,
  phoneDerivedSubject,
} from "@/lib/otp-challenge";

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
 */
export async function POST(request: NextRequest) {
  let body: { employeeId?: string; phone?: string; businessId?: string; businessSlug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

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

      let candidatePhone: string | null = null;
      let phone: string | null = member.phone_e164;
      if (payload.mayAttachPhone && body.phone) {
        const candidate = canonicalMemberPhone(body.phone);
        if (!candidate) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        // A candidate typed at this step still needs the OTP below to stick;
        // storing it happens in verify, not here.
        candidatePhone = candidate;
        phone = candidate;
      }
      if (!phone) return NextResponse.json({ error: "phone_missing" }, { status: 400 });

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId: payload.businessId!,
        mayAttachPhone: payload.mayAttachPhone,
        phone: candidatePhone,
      });

      return dispatchOrError({
        businessId: payload.businessId!,
        userId: member.id,
        phone,
        token,
        /**
         * Issue #854 (P0.8): the purpose is decided from what this token
         * proved, not from the request body. Attaching or moving a number is a
         * `change_login_phone` transaction; re-proving the number already on
         * file is `verify_login_phone`; everything else (below) is a plain
         * `login`.
         */
        purpose: candidatePhone ? "change_login_phone" : "verify_login_phone",
      });
    });
  }

  // ------------------------------------------------------------------ 2. roster pick → stored number
  if (body.employeeId) {
    const { businessId, error } = await resolveLoginBusinessId({
      ...body,
      host: requestHost(request.headers),
    });
    if (!businessId) {
      return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
    }

    return withTenant(businessId, async () => {
      const lockout = await checkLoginLockout(businessId, body.employeeId!);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE id = $1 AND business_id = $2 AND is_active`,
        [body.employeeId, businessId],
      );
      const member = rows[0];
      if (!member) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
      if (!member.phone_e164) {
        return NextResponse.json({ error: "phone_missing" }, { status: 400 });
      }

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId,
        mayAttachPhone: false,
        phone: null,
      });
      return dispatchOrError({
        businessId,
        userId: member.id,
        phone: member.phone_e164,
        token,
        purpose: "login",
      });
    });
  }

  // ------------------------------------------------------------------ 3. direct phone login
  const phone = canonicalMemberPhone(body.phone);
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });

  const { businessId, error } = await resolveLoginBusinessId({
    ...body,
    host: requestHost(request.headers),
  });

  if (businessId) {
    return withTenant(businessId, async () => {
      /*
       * #1386 — the canonical global identity wins over a membership phone.
       *
       * A business administrator can move an employee's `users.phone_e164` and
       * prove it with an OTP they receive; that must not become a login
       * credential for a person whose *global* number is somewhere else. When
       * the membership is linked to a global identity that holds a verified
       * number, only that number may open this door. A membership with no
       * global identity (legacy PIN staff) or whose identity has no global
       * number yet keeps the old behaviour.
       */
      const { rows } = await query<MemberRow>(
        `SELECT u.id, u.full_name, u.phone_e164
           FROM users u
           JOIN businesses b ON b.id = u.business_id
           LEFT JOIN platform_users p ON p.id = u.platform_user_id
          WHERE u.business_id = $1 AND u.is_active AND b.status = 'active'
            AND (
              (
                u.platform_user_id IS NOT NULL
                AND p.is_active = true
                AND p.phone_e164 = $2
                AND p.phone_verified_at IS NOT NULL
              )
              OR (
                u.phone_e164 = $2
                AND u.phone_verified_at IS NOT NULL
                AND (u.platform_user_id IS NULL OR p.phone_e164 IS NULL)
              )
            )`,
        [businessId, phone],
      );
      const member = rows[0];
      if (!member) return antiEnumerationResponse(phone);

      const lockout = await checkLoginLockout(businessId, member.id);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId,
        mayAttachPhone: false,
        phone: null,
      });
      return dispatchOrError({
        businessId,
        userId: member.id,
        phone,
        token,
        purpose: "login",
      });
    });
  }

  // No origin named a business (a single-box install without host routing).
  //
  // Issue #854 (P1.18): the number may match members in several businesses, and
  // the previous answer listed them — names and ids — *before* any proof that
  // the caller holds the number. A door that reads a membership list out loud to
  // anyone who types a number is a free account-enumeration oracle, and the
  // issue asks for the business selector to appear only after the OTP succeeds.
  //
  // So the challenge is minted against the number itself
  // (`phoneDerivedSubject`), one code and one attempt budget for the phone
  // rather than one per candidate. `verify` then resolves the candidates and
  // asks which business — by which point possession has been proven. When only
  // one business matches, nothing is revealed either: the same `sent` shape
  // comes back and verification resolves it.
  //
  // Cross-tenant by nature, like /api/auth/login, and on the same documented
  // bypass.
  if (error === "business_required") {
    return withoutTenantScope("login", async () => {
      /*
       * #1386 — resolve the canonical global identity first. Only when the
       * number belongs to no global identity do we fall back to the legacy
       * membership phone (a PIN-era membership, or one whose global identity
       * has no verified number yet). Two global identities claiming one number
       * is refused rather than guessed, exactly as the password door does.
       */
      const { rows: global } = await query<{ id: string }>(
        `SELECT DISTINCT p.id
           FROM platform_users p
           JOIN users u ON u.platform_user_id = p.id
           JOIN businesses b ON b.id = u.business_id
          WHERE p.phone_e164 = $1 AND p.phone_verified_at IS NOT NULL AND p.is_active
            AND u.is_active AND b.status = 'active'`,
        [phone],
      );
      if (global.length > 1) return antiEnumerationResponse(phone);

      let known = global.length === 1;
      if (!known) {
        const { rows: legacy } = await query<{ id: string }>(
          `SELECT u.id
             FROM users u
             JOIN businesses b ON b.id = u.business_id
             LEFT JOIN platform_users p ON p.id = u.platform_user_id
            WHERE u.phone_e164 = $1 AND u.is_active
              AND u.phone_verified_at IS NOT NULL
              AND b.status = 'active'
              AND (
                u.platform_user_id IS NULL
                OR (p.is_active = true AND p.phone_e164 IS NULL)
              )`,
          [phone],
        );
        known = legacy.length > 0;
      }

      // Unknown number and known number are answered identically — including
      // the "no SMS was sent" part, which is why the challenge is only minted
      // on the hit path and the miss path returns the same token shape.
      if (!known) return antiEnumerationResponse(phone);

      const subject = await phoneDerivedSubject(phone);
      const limit = await checkPhoneOtpRateLimit(`phone:${phone}`);
      if (!limit.allowed) {
        return NextResponse.json(
          { error: "rate_limited", retryAfterMs: limit.retryAfterMs },
          { status: 429 },
        );
      }

      const issued = await issueOtpChallenge({
        subjectRealm: PENDING_PHONE_REALM,
        subjectId: subject,
        purpose: "login",
        candidatePhoneE164: phone,
      });

      try {
        const provider = await getSmsProvider();
        await provider.sendOtp(phone, issued.code);
      } catch (err) {
        await consumeAllChallenges({
          subjectRealm: PENDING_PHONE_REALM,
          subjectId: subject,
          purpose: "login",
        }).catch(() => {});
        console.error("Phone-OTP dispatch failed", err);
        const message =
          err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
        return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
      }

      const token = await signPhonePendingToken({
        sub: null,
        businessId: "00000000-0000-0000-0000-000000000000",
        mayAttachPhone: false,
        phone: null,
        /**
         * The number is not a secret from the person who typed it, and carrying
         * it is what lets verification resolve the candidate members without a
         * server-side session. It is a signed claim, so it cannot be swapped.
         */
        candidatePhone: phone,
        multiBusiness: true,
      });

      return NextResponse.json({
        status: "sent",
        maskedPhone: maskPhoneE164(phone),
        token,
        expiresInSeconds: 5 * 60,
        purpose: "login",
      });
    });
  }

  return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
}

/**
 * Send the code, or translate the failure. Shared by all three modes so the
 * Kavenegar user-fault/operator-fault split (see the challenge route's twin
 * comment) is decided in exactly one place.
 */
async function dispatchOrError(options: {
  businessId: string;
  userId: string;
  phone: string;
  token: string;
  purpose: "login" | "verify_login_phone" | "change_login_phone";
}): Promise<NextResponse> {
  let maskedPhone = maskPhoneE164(options.phone);
  try {
    const sent = await sendEmployeePhoneOtp({
      businessId: options.businessId,
      userId: options.userId,
      phone: options.phone,
      purpose: options.purpose,
    });
    if (!sent.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
        { status: 429 },
      );
    }
    maskedPhone = sent.maskedPhone;
  } catch (err) {
    console.error("Phone-OTP dispatch failed", err);
    // Only the half of a Kavenegar failure the member can *act on* is theirs
    // to see; an operator-side fault (empty credit, bad key) stays generic so
    // the member is not sent re-typing a number that was never the problem.
    const message =
      err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
    return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
  }

  /**
   * The masked destination comes from the send itself — it is the number the
   * code actually went to, not the one the body asked for (#854 P0.8).
   */
  return NextResponse.json({
    status: "sent",
    maskedPhone,
    token: options.token,
    expiresInSeconds: 5 * 60,
    purpose: options.purpose,
  });
}

/**
 * The answer to a number nothing matches: byte-identical to success minus a
 * code ever being sent. The token carries no subject, so its verify can only
 * ever say «کد درست نیست» — the shape holds, the oracle doesn't.
 */
async function antiEnumerationResponse(phone: string): Promise<NextResponse> {
  const token = await signPhonePendingToken({
    sub: null,
    businessId: "00000000-0000-0000-0000-000000000000",
    mayAttachPhone: false,
    phone: null,
  });
  return NextResponse.json({ status: "sent", maskedPhone: maskPhoneE164(phone), token });
}
