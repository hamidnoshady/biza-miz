import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  TeamError,
  beginInvitationAcceptance,
  completeInvitationAcceptance,
  previewInvitation,
} from "@/lib/team-service";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import { resolveDeviceId } from "@/lib/device-service";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { countRemainingRecoveryCodes } from "@/lib/mfa-recovery";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  signMfaPendingToken,
} from "@/lib/mfa-service";
import {
  distinctSecondFactorMethods,
  enrolmentRequirement,
  mfaAppliesToRole,
  shouldChallengeMfaOnLogin,
} from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TeamError) {
    return NextResponse.json(
      { error: err.message, message: authErrorMessage(err.message) },
      { status: err.status },
    );
  }
  throw err;
}

/**
 * What an invitation link is offering, before it is accepted.
 *
 * Public and session-less by necessity: the person following the link has no
 * account here yet, and by definition no membership of the business that
 * invited them. The token is the credential, and it is only ever exchanged for
 * the business name and the invited address — never for anything about the
 * business's data.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  try {
    return NextResponse.json(await previewInvitation(token));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Accepts an invitation and signs the new member in.
 *
 * Issue #854 (P0.4): invitation possession is **not** proof of identity.
 *
 * For an address that already has a global identity the previous version linked
 * that identity and minted a tenant session outright, so anyone holding a
 * forwarded invitation link received the account holder's membership without a
 * password and without MFA. The ceremony is now the documented one:
 *
 *     invitation token
 *       → identify intended account/business   (acceptInvitation, locked row)
 *       → primary authentication               (password verified against the
 *                                               *existing* identity hash)
 *       → required MFA                          (policy over all memberships)
 *       → accept membership
 *       → tenant session
 *
 * A brand-new address is different in exactly one way: the invitation *is* the
 * permission to create the identity, so the password supplied here becomes its
 * credential (`acceptInvitation` runs it through the shared strength validator).
 *
 * MFA is evaluated by the same helpers every other account door uses — the
 * business policy plus the identity's own enrolments, with SMS deliberately
 * excluded from the second-factor pool because the invitation itself was not
 * proven by SMS. When a factor is required the route returns `mfaRequired` and
 * a short-lived pending token instead of a cookie; `/api/auth/mfa/verify`
 * completes the ceremony.
 */
export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { error: AUTH_ERROR_CODES.missingToken, message: authErrorMessage(AUTH_ERROR_CODES.missingToken) },
      { status: 400 },
    );
  }
  const password = typeof body.password === "string" ? body.password : null;

  try {
    /**
     * Phase 1 — the invitation and the password. The membership is **not**
     * written here: an acceptance abandoned at the second factor must leave no
     * membership behind, and, for a first-time invitee, no half-accepted
     * account. What phase 1 does commit is the identity itself, because the
     * second factor needs a subject to hang off.
     */
    const staged = await beginInvitationAcceptance(token, password);

    /**
     * The MFA decision, made *before* any session exists. Reads run under the
     * invitation's business so the business policy is the one that applies to
     * the membership being accepted.
     */
    const mfa = await withTenant(staged.businessId, async () => {
      const policy = await getMfaPolicy(staged.businessId);
      const requiresMfa = mfaAppliesToRole(staged.role, policy);
      const enrolments = filterActiveMfaEnrolments(
        await getAccountMfaEnrolments("platform_user", staged.platformUserId),
      );
      if (!requiresMfa && enrolments.length === 0) return null;

      const graceUntil = await getMfaGracePeriod("platform_user", staged.platformUserId);
      const requirement = enrolmentRequirement({
        hasPrimary: enrolments.length > 0,
        graceUntil,
        hasGraceRecord: graceUntil !== null,
        role: staged.role,
      });
      if (
        !shouldChallengeMfaOnLogin({
          hasConfirmedEnrolment: enrolments.length > 0,
          appliesToRole: requiresMfa,
          requirement,
        })
      ) {
        return null;
      }

      /**
       * The second factor must be distinct from anything the invitation proved
       * — and an invitation proves *nothing* about a phone, so SMS is excluded
       * outright rather than treated as "already used". A member with only an
       * SMS factor enrolled falls through to recovery codes; with neither, they
       * are sent to enrol a TOTP factor first, which is the same state a
       * password login leaves them in.
       */
      const methods = distinctSecondFactorMethods(enrolments, "password").filter(
        (method) => method !== "sms_otp",
      );
      const remainingRecoveryCodes = await countRemainingRecoveryCodes(
        "platform_user",
        staged.platformUserId,
      );

      /**
       * The pending token carries the invitation it belongs to, so the factor's
       * success path knows to finish the acceptance (issue #854 P0.4) — the
       * membership is written there, immediately before the session, and never
       * before the second factor is proven.
       */
      const mfaToken = await signMfaPendingToken({
        sub: staged.platformUserId,
        method: methods[0] ?? null,
        authRealm: "tenant_password",
        businessId: staged.businessId,
        primaryAuth: "password",
        invitationId: staged.invitationId,
      });

      return {
        mfaToken,
        methods,
        remainingRecoveryCodes,
        requirement,
      };
    });

    if (mfa) {
      return NextResponse.json({
        ok: false,
        mfaRequired: true,
        mfaState: mfa.requirement,
        mfaToken: mfa.mfaToken,
        mfaMethod: mfa.methods[0] ?? null,
        availableMethods: mfa.methods,
        remainingRecoveryCodes: mfa.remainingRecoveryCodes,
        businessId: staged.businessId,
      });
    }

    /**
     * Phase 2 — every factor is proven, so the membership lands now.
     */
    const result = await completeInvitationAcceptance({
      invitationId: staged.invitationId,
      platformUserId: staged.platformUserId,
    });

    /**
     * Every other door mints a revocable server-side `employee_sessions` row
     * alongside the JWT; this one did not, so an invitation session could be
     * neither listed nor revoked from Profile. It does now, labelled with the
     * door it came through (#854 P2.27).
     */
    const deviceLabel =
      request.headers.get("user-agent")?.slice(0, 120) ?? "invitation";
    const { session: employeeSession } = await createSession(
      result.userId,
      result.businessId,
      {
        locationId: result.locationId,
        deviceLabel,
        deviceId: await resolveDeviceId(undefined, result.businessId),
        loginMethod: "invitation",
        userAgent: request.headers.get("user-agent"),
      },
    );

    const sessionToken = await signSession({
      sub: result.userId,
      role: result.role,
      businessId: result.businessId,
      businessSlug: result.businessSlug,
      businessSubdomain: result.businessSubdomain,
      locationId: result.locationId,
      fullName: result.fullName,
      platformUserId: result.platformUserId,
      mfaVerified: false,
      recentAuthAt: Math.floor(Date.now() / 1000),
      employeeSessionId: employeeSession.id,
    });

    const res = NextResponse.json({ ok: true, locationScope: result.locationScope });
    res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
