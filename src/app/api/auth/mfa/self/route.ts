import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { query, withoutTenantScope } from "@/lib/db";
import {
  enrolmentRequirement,
  graceDaysRemaining,
  mfaAppliesToRole,
  selectPrimaryMfaEnrolment,
  type MfaMethod,
} from "@/lib/mfa";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  globalMfaRequirementForPlatformUser,
  removeMfaFactorChecked,
  setPrimaryMfaEnrolment,
} from "@/lib/mfa-service";
import { enrolMfaMethod, issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { verifyAndConfirmPendingMfaEnrolment } from "@/lib/mfa-verify";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/lib/mfa-recovery";
import { getMfaPolicy } from "@/lib/mfa-policy";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { SECURITY_AUDIT_ACTIONS, recordSecurityAudit } from "@/lib/security-audit";

/** Every action `POST /api/auth/mfa/self` accepts (Issue #854 — P2.2). */
const KNOWN_MFA_ACTIONS: ReadonlySet<string> = new Set([
  "enrol",
  "confirm",
  "remove",
  "set_primary",
  "regenerate_recovery_codes",
  "resend_challenge",
] as const);

export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const policy = await getMfaPolicy(session.businessId);
  const applies = mfaAppliesToRole(session.role, policy);

  /**
   * Issue #854 (P1.15): the second factor belongs to the global identity, which
   * a Hybrid site replicates but does not originate. The card renders from this
   * surface instead of hard-coding `profile === "hybrid"`, so it can show the
   * number/secret read-only *and* the reason.
   */
  const deployment = await readDeploymentProfile(session.businessId);
  const credential = describeCredentialSurface(deployment.profile, "totp_secret");

  if (!session.platformUserId) {
    return NextResponse.json({
      applies: false,
      requirement: "not_required" as const,
      graceUntil: null,
      graceDaysLeft: null,
      methods: [],
      methodNames: [],
      pendingMethods: [],
      primaryMethod: null,
      phone: null,
      requireForManagers: policy.requireForManagers,
      unusedRecoveryCodes: 0,
      recoveryCodesRemaining: 0,
      policy,
      recentAuth: isRecentAuth(session),
      deploymentProfile: deployment.profile,
      loginManagedByCloud: deployment.profile === "hybrid",
      credential,
    });
  }

  const subjectId = session.platformUserId;
  const now = new Date();
  const [enrolments, graceUntil, recoveryRemaining] = await Promise.all([
    getAccountMfaEnrolments("platform_user", subjectId),
    getMfaGracePeriod("platform_user", subjectId),
    countRemainingRecoveryCodes("platform_user", subjectId),
  ]);

  const activeEnrolments = filterActiveMfaEnrolments(enrolments);
  const pendingEnrolments = enrolments.filter(
    (e) => e.confirmed_at === null && !(e.method === "sms_otp" && e.is_primary),
  );
  const primary = selectPrimaryMfaEnrolment(activeEnrolments);
  const smsRow =
    activeEnrolments.find((e) => e.method === "sms_otp") ??
    pendingEnrolments.find((e) => e.method === "sms_otp");

  const requirement = applies
    ? enrolmentRequirement(
        {
          hasPrimary: activeEnrolments.length > 0,
          graceUntil,
          hasGraceRecord: graceUntil !== null,
          role: session.role,
        },
        now,
      )
    : ("not_required" as const);

  const graceDaysLeft = graceDaysRemaining(graceUntil, now);

  /**
   * Issue #854 (P2.25) — the resend countdown and the expiry line both read
   * the live challenge's own timestamps, so a reload mid-ceremony shows the
   * honest remaining window instead of a fresh timer. Live means neither
   * consumed nor expired; anything else is not a window the member is in.
   * The query is not gated on a *pending enrolment* existing: a replacement
   * (P2.21) proves a new number without staging a row, so its challenge is
   * the only trace of the ceremony in flight.
   */
  let smsChallengeRequestedAt: string | null = null;
  let smsChallengeExpiresAt: string | null = null;
  {
    const { rows } = await query<{ created_at: Date; expires_at: Date }>(
      `SELECT created_at, expires_at
         FROM mfa_challenges
        WHERE subject_id = $1
          AND subject_realm = 'platform_user'
          AND purpose = 'mfa_enrol_sms'
          AND consumed_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [subjectId],
    );
    if (rows[0]) {
      smsChallengeRequestedAt = new Date(rows[0].created_at).toISOString();
      smsChallengeExpiresAt = new Date(rows[0].expires_at).toISOString();
    }
  }

  /**
   * Issue #854 (P2.21) — resuming a reload of the *fresh-enrolment* ceremony:
   * the staged row holds the number being proven, and `confirm` must name it
   * to keep the redemption bound to exactly that destination. This is the
   * member's own staging data, read back on their own authenticated session —
   * the same value the enrol response handed them when they started. A
   * *replacement* deliberately has no row to resume from; that ceremony
   * restarts after a reload, which is what the screen says.
   */
  const pendingSmsPhone =
    pendingEnrolments.find((e) => e.method === "sms_otp")?.phone_e164 ?? null;

  return NextResponse.json({
    applies,
    requirement,
    graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
    graceDaysLeft,
    methods: activeEnrolments.map((e) => ({
      method: e.method,
      isPrimary: e.is_primary,
      phoneHint: e.phone_e164 ? `***${e.phone_e164.slice(-4)}` : null,
      confirmedAt: e.confirmed_at ? new Date(e.confirmed_at).toISOString() : null,
    })),
    methodNames: activeEnrolments.map((e) => e.method),
    pendingMethods: pendingEnrolments.map((e) => e.method),
    primaryMethod: primary?.method ?? null,
    phone: smsRow?.phone_e164 ? `***${smsRow.phone_e164.slice(-4)}` : null,
    requireForManagers: policy.requireForManagers,
    unusedRecoveryCodes: recoveryRemaining,
    recoveryCodesRemaining: recoveryRemaining,
    policy,
    recentAuth: isRecentAuth(session),
    deploymentProfile: deployment.profile,
    loginManagedByCloud: deployment.profile === "hybrid",
    credential,
    smsChallengeRequestedAt,
    smsChallengeExpiresAt,
    pendingSmsPhone,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.platformUserId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    action?: string;
    method?: string;
    phone?: string;
    code?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.loginManagedByCloud,
        message: authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud),
      },
      { status: 409 },
    );
  }

  const subjectId = session.platformUserId;

  // Issue #854 (P2.2): the action is an explicit allowlist, and anything else
  // is refused *before* the handler falls through to "enrol a new method". A
  // typo (`"remove_factor"`) used to start an enrolment ceremony instead of
  // saying no, which is the wrong default for a credential-mutating endpoint.
  const action = body.action ?? "enrol";
  if (!KNOWN_MFA_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "unknown_action", allowedActions: [...KNOWN_MFA_ACTIONS] },
      { status: 400 },
    );
  }

  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_users WHERE id = $1`,
      [subjectId],
    );
    const email = rows[0]?.email;
    if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    if (action === "regenerate_recovery_codes") {
      const enrolments = filterActiveMfaEnrolments(
        await getAccountMfaEnrolments("platform_user", subjectId),
      );
      if (enrolments.length === 0) {
        return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
      }
      const recoveryCodes = await issueRecoveryCodes("platform_user", subjectId);
      /**
       * The row records that the set was replaced and how many codes it holds —
       * never the codes (#854 P2.22). Regeneration is destructive to the old
       * set, so "when did this happen and who did it" is the whole question an
       * investigator asks.
       */
      await recordSecurityAudit({
        realm: "tenant",
        businessId: session.businessId,
        actorUserId: session.sub,
        platformUserId: subjectId,
        action: SECURITY_AUDIT_ACTIONS.recoveryCodesRegenerated,
        entity: "platform_user",
        entityId: subjectId,
        payload: { issuedCount: recoveryCodes.length, previousSetsInvalidated: true },
      });
      return NextResponse.json({ recoveryCodes });
    }

    if (action === "resend_challenge") {
      /*
       * Issue #854 (invariant 4) — purpose isolation reached this call site
       * last. The only screen that resends through `mfa/self` is the enrolment
       * card waiting on a pending SMS factor, so the code it mints is an
       * enrolment code. It used to inherit the `mfa_login` default, which made
       * the login interstitial's code and the enrolment code the same
       * transaction type — and, once `confirm` was narrowed to enrolment
       * purposes, would have left the enrolment screen unable to finish.
       * Signing in has its own route (`/api/auth/mfa/challenge`).
       *
       * The optional `phone` (P2.21): a *replacement* ceremony proves a new
       * number without staging a pending row, so the stored sms_otp factor
       * still points at the old one — a resend that read the row would text
       * the number being replaced. Naming the destination sends the code where
       * the ceremony is actually happening, and the confirm step's phone
       * binding is what makes a code sent anywhere else unspendable.
       */
      const resendPhone =
        typeof body.phone === "string" && body.phone.trim() !== ""
          ? canonicalMemberPhone(body.phone)
          : null;
      if (typeof body.phone === "string" && body.phone.trim() !== "" && !resendPhone) {
        return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
      }
      const challenge = await issueSmsMfaChallenge({
        subjectRealm: "platform_user",
        subjectId,
        email,
        purpose: "mfa_enrol_sms",
        phoneE164: resendPhone,
        requireActiveFactor: false,
      });
      if (!challenge.ok) {
        const status = challenge.error === "rate_limited" ? 429 : 400;
        return NextResponse.json(
          { error: challenge.error, retryAfterMs: challenge.retryAfterMs },
          { status },
        );
      }
      await recordSecurityAudit({
        realm: "tenant",
        businessId: session.businessId,
        actorUserId: session.sub,
        platformUserId: subjectId,
        action: SECURITY_AUDIT_ACTIONS.mfaChallengeSent,
        entity: "platform_user",
        entityId: subjectId,
        // The masked destination, never the number and never the code.
        payload: { method: "sms_otp", purpose: "mfa_enrol_sms", maskedPhone: challenge.maskedPhone },
      });
      return NextResponse.json({
        status: "challenge_sent",
        maskedPhone: challenge.maskedPhone,
      });
    }

    if (action === "confirm") {
      const method: MfaMethod | null =
        body.method === "totp" || body.method === "sms_otp" ? body.method : null;
      const code = body.code?.trim() ?? "";
      if (!method || !code) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      /*
       * Issue #854 (P2.21) — a named phone is a hard binding: if it was
       * provided but does not canonicalise, the request is refused instead of
       * quietly confirming against a challenge bound to whatever destination
       * happened to be stored. (A confirmation that names no phone keeps the
       * pre-replacement behaviour for fresh enrolments.)
       */
      let expectedPhoneE164: string | null = null;
      if (method === "sms_otp" && typeof body.phone === "string" && body.phone.trim() !== "") {
        expectedPhoneE164 = canonicalMemberPhone(body.phone);
        if (!expectedPhoneE164) {
          return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        }
      }
      /**
       * Issue #854 (P1.11) — this is the enrolment ceremony, so it uses the
       * verifier *named* for confirming a pending enrolment.
       *
       * It called `verifyAndConfirmMfaCode` with no flag, which defaults to the
       * strict `verifyExistingConfirmedMfaFactor` — and that refuses a row whose
       * `confirmed_at` is still null, which is by definition every row this
       * action exists to activate. A member who scanned the QR code and typed a
       * correct code was told «کد واردشده درست نیست» and could never finish
       * enrolling: the button that turns a pending factor on was guarded by a
       * check that requires it to be on already.
       *
       * The strict path is right everywhere *else* — `step-up` and the login
       * interstitial must not accept a half-finished enrolment as a second
       * factor (that was P1.11's actual risk). So the two ceremonies are now
       * two explicitly named calls rather than one flag that only this caller
       * was supposed to pass.
       */
      const detail = await verifyAndConfirmPendingMfaEnrolment({
        subjectRealm: "platform_user",
        subjectId,
        method,
        code,
        useRecoveryCode: false,
        /**
         * Issue #854 (P2.21) — when the confirmation names a phone, the code
         * must redeem against a challenge bound to exactly it. If the factor
         * was already confirmed on another number, this same field is what
         * turns the confirmation into an atomic replacement (see
         * `confirmMfaEnrolment`).
         */
        expectedPhoneE164:
          method === "sms_otp" ? canonicalMemberPhone(body.phone ?? null) : null,
        /*
         * Issue #854 (invariant 12) — the audit row rides the same transaction
         * as the confirmation it records, so a factor can never become active
         * without a row saying who turned it on.
         */
        audit: {
          businessId: session.businessId,
          actorUserId: session.sub,
          platformUserId: subjectId,
        },
      });
      if (detail.outcome === "rejected") {
        return NextResponse.json({ error: "invalid_code" }, { status: 401 });
      }
      return NextResponse.json({
        status: "confirmed",
        method,
        recoveryCodes: detail.recoveryCodes,
      });
    }

    if (action === "set_primary") {
      if (body.method !== "totp" && body.method !== "sms_otp") {
        return NextResponse.json({ error: "invalid_method" }, { status: 400 });
      }
      const res = await setPrimaryMfaEnrolment("platform_user", subjectId, body.method, {
        audit: {
          businessId: session.businessId,
          actorUserId: session.sub,
          platformUserId: subjectId,
        },
      });
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, primaryMethod: body.method });
    }

    if (action === "remove") {
      if (body.method !== "totp" && body.method !== "sms_otp") {
        return NextResponse.json({ error: "invalid_method" }, { status: 400 });
      }

      /**
       * Issue #854 (P0.9 + atomicity) — one locked decision, not three hops.
       *
       * The question "may the last factor go?" is about the *global identity*,
       * not the business the person happens to be standing in. Asking `applies`
       * (this business's policy, this business's role) let an Owner in Business
       * A walk into Business B — where their role or that business's policy did
       * not require MFA — and delete the factor that was protecting the
       * owner-level access in A. That is answered across all the identity's
       * active memberships, and it is answered **inside the account lock**,
       * because two parallel removals of a two-factor account used to each see
       * two factors and each delete one, leaving a required account with none.
       *
       * The two flags matter and used to be conflated:
       *
       *  - `allowRemoveLast: true` says a *human* has decided losing the last
       *    factor is acceptable for this account (they are removing it from the
       *    one place it is required, which the cross-membership check below has
       *    just approved, or they are taking the factor off an account they are
       *    about to stop using). Without it the service's own default refuses
       *    the last factor regardless — which is what a member whose only
       *    *binding* membership did not require MFA kept hitting.
       *  - `evaluateGlobalRequirement: true` says the cross-membership rule is
       *    the thing that decides, and it is evaluated while the account is
       *    locked.
       */
      const result = await removeMfaFactorChecked({
        subjectRealm: "platform_user",
        subjectId,
        method: body.method,
        allowRemoveLast: true,
        evaluateGlobalRequirement: true,
        audit: {
          businessId: session.businessId,
          actorUserId: session.sub,
          platformUserId: subjectId,
        },
      });
      if (!result.ok) {
        if (result.error === "not_enrolled") {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        return NextResponse.json(
          {
            error: "mfa_required",
            reason: result.reason,
            requirement: await globalMfaRequirementForPlatformUser(subjectId),
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    const result = await enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId,
      email,
      method: body.method,
      phone: body.phone,
      sendSmsChallenge: true,
      // Issue #854 (P2.21): naming a different number than the confirmed SMS
      // factor's is a replacement request, not a second SMS factor.
      replaceConfirmed: true,
    });
    if (!result.ok) {
      const status =
        result.error === "already_enrolled"
          ? 409
          : result.error === "rate_limited"
            ? 429
            : 400;
      return NextResponse.json(
        { error: result.error, retryAfterMs: result.retryAfterMs },
        { status },
      );
    }

    /**
     * Staging a factor is a security event even though it activates nothing:
     * it is the moment a new number or secret enters the account, and the row
     * carries the masked destination so an investigator can tell *which* number
     * was staged without the row itself holding a credential.
     */
    await recordSecurityAudit({
      realm: "tenant",
      businessId: session.businessId,
      actorUserId: session.sub,
      platformUserId: subjectId,
      action: SECURITY_AUDIT_ACTIONS.mfaEnrolStarted,
      entity: "platform_user",
      entityId: subjectId,
      payload: {
        method: result.method,
        maskedPhone: result.maskedPhone,
        pendingConfirmation: true,
      },
    });

    return NextResponse.json({
      status: result.status,
      method: result.method,
      totpSecret: result.totpSecret,
      totpUrl: result.totpUrl,
      totpQr: result.totpQr,
      phone: result.phone,
      maskedPhone: result.maskedPhone,
      recoveryCodes: result.recoveryCodes,
    });
  });
});
