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
  removeMfaEnrolment,
  setPrimaryMfaEnrolment,
} from "@/lib/mfa-service";
import { enrolMfaMethod, issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/lib/mfa-recovery";
import { getMfaPolicy } from "@/lib/mfa-policy";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import { readDeploymentProfile } from "@/lib/deployment-mode";

export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const policy = await getMfaPolicy(session.businessId);
  const applies = mfaAppliesToRole(session.role, policy.requireForManagers);

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
    return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
  }

  const subjectId = session.platformUserId;
  const policy = await getMfaPolicy(session.businessId);
  const applies = mfaAppliesToRole(session.role, policy.requireForManagers);

  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{ email: string }>(
      `SELECT email::text AS email FROM platform_users WHERE id = $1`,
      [subjectId],
    );
    const email = rows[0]?.email;
    if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    if (body.action === "regenerate_recovery_codes") {
      const enrolments = filterActiveMfaEnrolments(
        await getAccountMfaEnrolments("platform_user", subjectId),
      );
      if (enrolments.length === 0) {
        return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
      }
      const recoveryCodes = await issueRecoveryCodes("platform_user", subjectId);
      return NextResponse.json({ recoveryCodes });
    }

    if (body.action === "resend_challenge") {
      const challenge = await issueSmsMfaChallenge({
        subjectRealm: "platform_user",
        subjectId,
        email,
      });
      if (!challenge.ok) {
        const status = challenge.error === "rate_limited" ? 429 : 400;
        return NextResponse.json(
          { error: challenge.error, retryAfterMs: challenge.retryAfterMs },
          { status },
        );
      }
      return NextResponse.json({
        status: "challenge_sent",
        maskedPhone: challenge.maskedPhone,
      });
    }

    if (body.action === "confirm") {
      const method: MfaMethod | null =
        body.method === "totp" || body.method === "sms_otp" ? body.method : null;
      const code = body.code?.trim() ?? "";
      if (!method || !code) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const detail = await verifyAndConfirmMfaCode({
        subjectRealm: "platform_user",
        subjectId,
        method,
        code,
        useRecoveryCode: false,
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

    if (body.action === "set_primary") {
      if (body.method !== "totp" && body.method !== "sms_otp") {
        return NextResponse.json({ error: "invalid_method" }, { status: 400 });
      }
      const res = await setPrimaryMfaEnrolment("platform_user", subjectId, body.method);
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, primaryMethod: body.method });
    }

    if (body.action === "remove") {
      if (body.method !== "totp" && body.method !== "sms_otp") {
        return NextResponse.json({ error: "invalid_method" }, { status: 400 });
      }
      const res = await removeMfaEnrolment("platform_user", subjectId, body.method, {
        allowRemoveLast: !applies,
      });
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: 400 });
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
