import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { platformCan } from "@/lib/platform-admin";
import {
  extendMfaGracePeriod,
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  listMfaAccountStatus,
  removeMfaEnrolment,
  resetAccountMfa,
  setPrimaryMfaEnrolment,
} from "@/lib/mfa-service";
import { enrolMfaMethod, issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import { verifyAndConfirmMfaCode } from "@/lib/mfa-verify";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/lib/mfa-recovery";
import {
  enrolmentRequirement,
  graceDaysRemaining,
  MFA_GRACE_DAYS_PLATFORM,
  MFA_GRACE_DAYS_TENANT,
  selectPrimaryMfaEnrolment,
} from "@/lib/mfa";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";

const MAX_GRACE_EXTENSION_DAYS = 30;

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  const now = new Date();
  const canReadSystem = platformCan(session.role, "system.read");
  const [accounts, allEnrolments, ownGrace, ownRecovery] = await Promise.all([
    canReadSystem ? listMfaAccountStatus(now) : Promise.resolve([]),
    getAccountMfaEnrolments("platform_admin", session.padmin),
    getMfaGracePeriod("platform_admin", session.padmin),
    countRemainingRecoveryCodes("platform_admin", session.padmin),
  ]);

  const activeEnrolments = filterActiveMfaEnrolments(allEnrolments);
  const pendingEnrolments = allEnrolments.filter((e) => !e.confirmed_at);
  const primary = selectPrimaryMfaEnrolment(activeEnrolments);
  const smsRow =
    activeEnrolments.find((e) => e.method === "sms_otp") ??
    pendingEnrolments.find((e) => e.method === "sms_otp");

  const graceDaysLeft = graceDaysRemaining(ownGrace, now);
  const requirement = enrolmentRequirement(
    {
      hasPrimary: activeEnrolments.length > 0,
      graceUntil: ownGrace,
      hasGraceRecord: ownGrace !== null,
      role: session.role,
    },
    now,
  );

  return NextResponse.json({
    accounts,
    self: {
      subjectId: session.padmin,
      requirement,
      graceUntil: ownGrace ? new Date(ownGrace).toISOString() : null,
      graceDaysLeft,
      methods: activeEnrolments.map((e) => ({
        method: e.method,
        isPrimary: e.is_primary,
        phoneHint: e.phone_e164 ? `***${e.phone_e164.slice(-4)}` : null,
      })),
      recoveryCodesRemaining: ownRecovery,
    },
    graceDays: { tenant: MFA_GRACE_DAYS_TENANT, platform: MFA_GRACE_DAYS_PLATFORM },
    // Flat fields for /platform/account
    methods: activeEnrolments.map((e) => e.method),
    pendingMethods: pendingEnrolments.map((e) => e.method),
    primaryMethod: primary?.method ?? null,
    phone: smsRow?.phone_e164 ?? null,
    graceDaysLeft,
    unusedRecoveryCodes: ownRecovery,
    recentAuth: isRecentAuth(session),
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformAdmin();
  if (guard.error) return guard.error;
  const session = guard.session;

  let body: {
    action?: string;
    method?: string;
    phone?: string;
    code?: string;
    subjectRealm?: string;
    subjectId?: string;
    days?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const recentError = requireRecentAuth(session);
  if (recentError) {
    return recentError;
  }

  // ---- Caller's own MFA enrolment & factor management ----
  if (
    body.action === "enrol" ||
    body.action === "confirm" ||
    body.action === "resend_challenge" ||
    body.action === "set_primary" ||
    body.action === "remove" ||
    body.action === "regenerate_recovery_codes"
  ) {
    return withoutTenantScope("platform", async () => {
      const { rows } = await query<{ email: string }>(
        `SELECT email::text AS email FROM platform_admins WHERE id = $1`,
        [session.padmin],
      );
      const email = rows[0]?.email;
      if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

      if (body.action === "enrol") {
        const result = await enrolMfaMethod({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          email,
          method: body.method,
          phone: body.phone,
        });
        if (!result.ok) {
          const status = result.error === "already_enrolled" ? 409 : 400;
          return NextResponse.json({ error: result.error }, { status });
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
      }

      if (body.action === "confirm") {
        if (body.method !== "totp" && body.method !== "sms_otp") {
          return NextResponse.json({ error: "invalid_method" }, { status: 400 });
        }
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!code) {
          return NextResponse.json({ error: "missing_code" }, { status: 400 });
        }
        const verification = await verifyAndConfirmMfaCode({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          method: body.method,
          code,
          useRecoveryCode: false,
        });
        if (verification.outcome === "rejected") {
          return NextResponse.json({ error: "invalid_code" }, { status: 400 });
        }
        await platformAudit({
          adminId: session.padmin,
          action: "platform_admin.mfa_confirmed",
          entity: "platform_admin",
          entityId: session.padmin,
          payload: { method: body.method },
        });
        return NextResponse.json({
          status: "confirmed",
          method: body.method,
          recoveryCodes: verification.recoveryCodes ?? [],
        });
      }

      if (body.action === "resend_challenge") {
        if (body.method !== "sms_otp") {
          return NextResponse.json({ error: "invalid_method" }, { status: 400 });
        }
        const all = await getAccountMfaEnrolments("platform_admin", session.padmin);
        const smsRow = all.find((e) => e.method === "sms_otp" && e.phone_e164);
        if (!smsRow?.phone_e164) {
          return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
        }
        const challenge = await issueSmsMfaChallenge({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          email,
        });
        if (!challenge.ok) {
          const status = challenge.error === "rate_limited" ? 429 : 502;
          return NextResponse.json(
            {
              error: challenge.error,
              retryAfterMs: challenge.retryAfterMs,
            },
            { status },
          );
        }
        return NextResponse.json({
          status: "challenge_sent",
          maskedPhone: challenge.maskedPhone,
        });
      }

      if (body.action === "set_primary") {
        if (body.method !== "totp" && body.method !== "sms_otp") {
          return NextResponse.json({ error: "invalid_method" }, { status: 400 });
        }
        const updated = await setPrimaryMfaEnrolment(
          "platform_admin",
          session.padmin,
          body.method,
        );
        if (!updated) {
          return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
        }
        return NextResponse.json({ status: "primary_updated", primaryMethod: body.method });
      }

      if (body.action === "remove") {
        if (body.method !== "totp" && body.method !== "sms_otp") {
          return NextResponse.json({ error: "invalid_method" }, { status: 400 });
        }
        const all = await getAccountMfaEnrolments("platform_admin", session.padmin);
        const active = filterActiveMfaEnrolments(all);
        const target = all.find((e) => e.method === body.method);
        if (target?.confirmed_at && active.length <= 1) {
          return NextResponse.json(
            { error: "cannot_remove_last_factor" },
            { status: 409 },
          );
        }
        await removeMfaEnrolment("platform_admin", session.padmin, body.method);
        await platformAudit({
          adminId: session.padmin,
          action: "platform_admin.mfa_removed",
          entity: "platform_admin",
          entityId: session.padmin,
          payload: { method: body.method },
        });
        return NextResponse.json({ status: "removed" });
      }

      if (body.action === "regenerate_recovery_codes") {
        const enrolments = filterActiveMfaEnrolments(
          await getAccountMfaEnrolments("platform_admin", session.padmin),
        );
        if (enrolments.length === 0) {
          return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
        }
        const recoveryCodes = await issueRecoveryCodes("platform_admin", session.padmin);
        await platformAudit({
          adminId: session.padmin,
          action: "platform_admin.mfa_recovery_regenerated",
          entity: "platform_admin",
          entityId: session.padmin,
        });
        return NextResponse.json({ recoveryCodes });
      }

      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    });
  }

  // ---- Cross-account actions (admins.manage required) ----
  const capability = await requirePlatformCapability("admins.manage");
  if (capability.error) return capability.error;

  const subjectRealm = body.subjectRealm;
  const subjectId = body.subjectId;
  if (
    (subjectRealm !== "platform_user" && subjectRealm !== "platform_admin") ||
    typeof subjectId !== "string" ||
    subjectId.length === 0
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const defaultDays =
    subjectRealm === "platform_admin" ? MFA_GRACE_DAYS_PLATFORM : MFA_GRACE_DAYS_TENANT;

  if (body.action === "extend_grace") {
    const requested = Number(body.days ?? defaultDays);
    if (!Number.isFinite(requested) || requested < 1 || requested > MAX_GRACE_EXTENSION_DAYS) {
      return NextResponse.json({ error: "invalid_days" }, { status: 400 });
    }
    const days = Math.round(requested);
    const graceUntil = await extendMfaGracePeriod(subjectRealm, subjectId, days);

    await platformAudit({
      adminId: session.padmin,
      action: "mfa.grace_extended",
      entity: subjectRealm,
      entityId: subjectId,
      payload: { days, graceUntil: graceUntil?.toISOString() ?? null },
    });

    return NextResponse.json({
      graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
      graceDaysLeft: graceDaysRemaining(graceUntil),
    });
  }

  if (body.action === "reset") {
    if (subjectRealm === "platform_admin") {
      return NextResponse.json({ error: "platform_admin_reset_refused" }, { status: 403 });
    }

    await resetAccountMfa(subjectRealm, subjectId, defaultDays);
    await platformAudit({
      adminId: session.padmin,
      action: "mfa.reset",
      entity: subjectRealm,
      entityId: subjectId,
      payload: { graceDays: defaultDays },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
