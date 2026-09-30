import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { withoutTenantScope, query } from "@/lib/db";
import {
  getAccountMfaEnrolments,
  getMfaGracePeriod,
} from "@/lib/mfa-service";
import { enrolMfaMethod } from "@/lib/mfa-enrol";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/lib/mfa-recovery";
import { enrolmentRequirement, graceDaysRemaining, mfaAppliesToRole } from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";
import { readDeploymentProfile } from "@/lib/deployment-mode";

/**
 * Phase 24 Wave 2 — self-service two-factor enrolment for a *signed-in* user.
 *
 * The `/api/auth/mfa/*` trio is the pre-session interstitial: it authenticates
 * on the five-minute `mfa_pending` token, which only exists for someone the
 * login route has refused a session to. That leaves the case the grace window
 * is built around — an Owner who *is* signed in, has been nagged, and wants to
 * enrol before the deadline — with nowhere to go. This is that route.
 *
 * Authenticated by the ordinary tenant session, and always about the caller's
 * own identity: `platformUserId` comes from the signed session, never from the
 * request body, so there is no shape of this endpoint that touches somebody
 * else's second factor.
 */
export const GET = withTenantScope(async () => {
  const session = await getSession();
  if (!session?.platformUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const policy = await getMfaPolicy(session.businessId);
  const enrolments = await getAccountMfaEnrolments("platform_user", session.platformUserId);
  const graceUntil = await getMfaGracePeriod("platform_user", session.platformUserId);
  const applies = mfaAppliesToRole(session.role, policy.requireForManagers);

  return NextResponse.json({
    applies,
    requirement: applies
      ? enrolmentRequirement({
          hasPrimary: enrolments.length > 0,
          graceUntil,
          hasGraceRecord: graceUntil !== null,
          role: session.role,
        })
      : "not_required",
    graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
    graceDaysLeft: graceDaysRemaining(graceUntil),
    methods: enrolments.map((e) => ({
      method: e.method,
      isPrimary: e.is_primary,
      // Masked, never whole: this is a read surface, and a full number here
      // would hand anyone with a borrowed session the Owner's mobile.
      phoneHint: e.phone_e164 ? `***${e.phone_e164.slice(-4)}` : null,
      confirmedAt: e.confirmed_at ? new Date(e.confirmed_at).toISOString() : null,
    })),
    recoveryCodesRemaining: await countRemainingRecoveryCodes(
      "platform_user",
      session.platformUserId,
    ),
    policy,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session?.platformUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; method?: string; phone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const platformUserId = session.platformUserId;
  // A paired desktop replicates the second factor from the cloud; enrolling or
  // regenerating codes here would be overwritten on the next sync.
  if ((await readDeploymentProfile(session.businessId)).profile === "hybrid") {
    return NextResponse.json({ error: "login_managed_by_cloud" }, { status: 409 });
  }

  return withoutTenantScope("identity", async () => {
    const { rows } = await query<{ email: string }>(
      `SELECT email FROM platform_users WHERE id = $1`,
      [platformUserId],
    );
    const email = rows[0]?.email;
    if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Regenerating burns the previous sheet — deliberately, and only on an
    // explicit request: someone who has spent eight of their ten codes needs a
    // way to get ten back without dismantling their enrolment.
    if (body.action === "regenerate_recovery_codes") {
      const enrolments = await getAccountMfaEnrolments("platform_user", platformUserId);
      if (enrolments.length === 0) {
        return NextResponse.json({ error: "not_enrolled" }, { status: 400 });
      }
      return NextResponse.json({
        recoveryCodes: await issueRecoveryCodes("platform_user", platformUserId),
      });
    }

    const result = await enrolMfaMethod({
      subjectRealm: "platform_user",
      subjectId: platformUserId,
      email,
      method: body.method,
      phone: body.phone,
      // Phase 42 — the issuer the authenticator app shows: this business's
      // name, so the entry is tellable apart from every other business the
      // person holds an entry for.
      issuer: (
        await query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [
          session.businessId,
        ])
      ).rows[0]?.name,
    });

    if (!result.ok) {
      const status = result.error === "already_enrolled" ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json({
      status: "provisioned",
      method: result.method,
      totpSecret: result.totpSecret,
      totpUrl: result.totpUrl,
      totpQr: result.totpQr,
      phone: result.phone,
      recoveryCodes: result.recoveryCodes,
    });
  });
});
