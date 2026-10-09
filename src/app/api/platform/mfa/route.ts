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
  removeMfaFactorChecked,
  resetAccountMfa,
  setPrimaryMfaEnrolment,
} from "@/lib/mfa-service";
import { enrolMfaMethod, issueSmsMfaChallenge } from "@/lib/mfa-enrol";
import {
  verifyAndConfirmMfaCode,
  verifyAndConfirmPendingMfaEnrolment,
} from "@/lib/mfa-verify";
import { canonicalMemberPhone } from "@/lib/phone-otp";
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

  // Issue #854 (P2.25) — the resend button shows a live countdown of the
  // server's 60-second challenge cooldown, which only works if the UI knows
  // when the last send actually happened. With a pending SMS enrolment, look
  // the last challenge's request time up instead of guessing from the click.
  let smsChallengeRequestedAt: string | null = null;
  if (pendingEnrolments.some((e) => e.method === "sms_otp")) {
    const { rows } = await query<{ otp_request_at: Date }>(
      `SELECT otp_request_at
         FROM mfa_challenges
        WHERE account_id = $1 AND subject_realm = 'platform'
        ORDER BY otp_request_at DESC
        LIMIT 1`,
      [session.padmin],
    );
    if (rows[0]) smsChallengeRequestedAt = new Date(rows[0].otp_request_at).toISOString();
  }

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
          // Issue #854 (P2.21): same replacement rule as the tenant ceremony.
          replaceConfirmed: true,
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
        /**
         * Issue #854 (P1.11) — the same inversion the tenant confirm action had:
         * `verifyAndConfirmMfaCode` without the flag is the *strict* path, which
         * requires `confirmed_at` to be set — i.e. it refuses the very row this
         * action activates, so a platform administrator could never finish
         * enrolling a factor. The enrolment ceremony names its verifier.
         */
        const verification = await verifyAndConfirmPendingMfaEnrolment({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          method: body.method,
          code,
          useRecoveryCode: false,
          // Issue #854 (P2.21): same binding as the tenant ceremony — the
          // named phone must be the one the redeemed challenge was sent to,
          // and a confirmed factor on another number gets atomically replaced.
          expectedPhoneE164:
            body.method === "sms_otp" ? canonicalMemberPhone(body.phone ?? null) : null,
          // Issue #854 (invariant 12): the platform realm's own audit table,
          // written inside the same transaction as the confirmation.
          auditRealm: "platform",
          audit: { actorUserId: session.padmin, platformUserId: session.padmin },
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
        // Issue #854 (invariant 4): an enrolment screen sends enrolment codes.
        const challenge = await issueSmsMfaChallenge({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          email,
          purpose: "mfa_enrol_sms",
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
          {
            auditRealm: "platform",
            audit: { actorUserId: session.padmin, platformUserId: session.padmin },
          },
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
        /**
         * Issue #854 — the same read-decide-write shape the tenant route had,
         * and the same fix: one locked transaction, so two concurrent removals
         * on a two-factor administrator cannot each see two factors and each
         * delete one. `evaluateGlobalRequirement` is false here because a
         * platform administrator has no memberships to evaluate — the rule that
         * applies is the caller's own ("do not remove the last factor").
         */
        const removal = await removeMfaFactorChecked({
          subjectRealm: "platform_admin",
          subjectId: session.padmin,
          method: body.method,
          allowRemoveLast: false,
          auditRealm: "platform",
          audit: { actorUserId: session.padmin, platformUserId: session.padmin },
        });
        if (!removal.ok) {
          if (removal.error === "not_enrolled") {
            return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
          }
          return NextResponse.json({ error: removal.error }, { status: 409 });
        }
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

    await resetAccountMfa(subjectRealm, subjectId, defaultDays, {
      auditRealm: "platform",
      audit: { actorUserId: session.padmin },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
