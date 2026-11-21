import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { PIN_MIN_LENGTH, PIN_POLICY_HINT, isValidPin } from "@/lib/pin-policy";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import { readSelfCredentialState } from "@/lib/self-credentials";
import { setPin, TeamError } from "@/lib/team-service";
import { toLatinDigits } from "@/lib/digits";
import { SELF_CREDENTIAL_AUDIT_ACTIONS, recordSecurityAudit } from "@/lib/security-audit";

/**
 * Issue #854 (P1.7) — changing *your own* PIN from `/settings/profile`.
 *
 * The only way to rotate a PIN used to be the Team screen, where an
 * administrator resets somebody else's. A member who simply wanted to change
 * theirs had two options: ask an admin (so somebody else knows when their PIN
 * changed and can set it to one they know), or do nothing. Personal security
 * belongs on the personal security screen, so the rotation moved here, and the
 * Team screen keeps the *administrative* reset (a member who forgot theirs).
 *
 * The bar matches the password change:
 *
 *  - **recent authentication** on the session (15 minutes), so an unlocked
 *    terminal left standing is not enough;
 *  - **no current PIN** — the member is signed in and the recent-auth window is
 *    the proof. Asking for the PIN the member may have *forgotten* made the one
 *    screen that can give them a new one unreachable: the old value is never
 *    disclosed by not asking for it, and the session already names whose PIN is
 *    being replaced;
 *  - **deployment authority** from the shared table: Hybrid and Local may
 *    originate a staff PIN (a till must be able to issue one while the uplink is
 *    down); a `apply`-only deployment may not, and says so with the shared
 *    notice;
 *  - **an actual rotation** (#854 follow-up F07): the new PIN must differ from
 *    the member's *own* current one (`pin_unchanged`) — checked inside `setPin`
 *    against the stored hash, atomically with the swap. Never against other
 *    members' PINs (#953).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const [state, deployment] = await Promise.all([
    readSelfCredentialState(session.businessId, session.sub),
    readDeploymentProfile(session.businessId),
  ]);
  if (!state) return NextResponse.json({ error: AUTH_ERROR_CODES.unauthorized }, { status: 401 });

  return NextResponse.json({
    hasPin: state.hasPin,
    pinPolicyHint: PIN_POLICY_HINT,
    recentAuth: isRecentAuth(session),
    deploymentProfile: deployment.profile,
    credential: describeCredentialSurface(deployment.profile, "staff_pin"),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  let body: { newPin?: string; confirmPin?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: AUTH_ERROR_CODES.badRequest }, { status: 400 });
  }

  const newPin = toLatinDigits(String(body.newPin ?? "").trim());
  const confirmPin = toLatinDigits(String(body.confirmPin ?? "").trim());
  if (!newPin) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.pinMissing,
        message: authErrorMessage(AUTH_ERROR_CODES.pinMissing),
      },
      { status: 400 },
    );
  }
  if (!isValidPin(newPin)) {
    return NextResponse.json(
      { error: AUTH_ERROR_CODES.invalidPin, message: PIN_POLICY_HINT },
      { status: 400 },
    );
  }
  if (body.confirmPin !== undefined && confirmPin !== newPin) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.pinConfirmationMismatch,
        message: authErrorMessage(AUTH_ERROR_CODES.pinConfirmationMismatch),
      },
      { status: 400 },
    );
  }

  const deployment = await readDeploymentProfile(session.businessId);
  const surface = describeCredentialSurface(deployment.profile, "staff_pin");
  if (!surface.editable) {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.loginManagedByCloud,
        message: surface.notice ?? authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud),
      },
      { status: 409 },
    );
  }

  const state = await readSelfCredentialState(session.businessId, session.sub);
  if (!state) return NextResponse.json({ error: AUTH_ERROR_CODES.unauthorized }, { status: 401 });

  const hasExistingPin = state.hasPin;

  try {
    await setPin(session.businessId, session.sub, newPin, session.sub, {
      selfService: true,
      /**
       * The rotation itself is audited inside `setPin` (`team.self_pin_changed`);
       * this row records the *surface* it came through, so the trail
       * distinguishes a Profile rotation from a Team-screen one when an incident
       * is reconstructed (#854 P2.22). It used to be written after the commit
       * with `.catch(() => {})`; it now commits with the rotation or not at all.
       */
      beforeCommit: (client) =>
        recordSecurityAudit(
          {
            realm: "tenant",
            businessId: session.businessId,
            actorUserId: session.sub,
            action: SELF_CREDENTIAL_AUDIT_ACTIONS.pinChangedSelf,
            entity: "user",
            entityId: session.sub,
            payload: { surface: "settings/profile", hadPin: hasExistingPin },
          },
          client,
        ),
    });
  } catch (err) {
    if (err instanceof TeamError) {
      /**
       * `TeamError.message` is already a code from the shared vocabulary
       * (`current_pin_required`, `login_managed_by_cloud`, …); translating it here keeps
       * the route's body identical to every other credential route's.
       */
      return NextResponse.json(
        { error: err.message, message: authErrorMessage(err.message) },
        { status: err.status },
      );
    }
    // The rotation and both audit rows rolled back together; say so instead of
    // a bare 500. The reason is logged, never the PIN.
    console.error(
      "self PIN change rolled back:",
      err instanceof Error ? err.message : "unknown error",
    );
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.credentialChangeFailed,
        message: authErrorMessage(AUTH_ERROR_CODES.credentialChangeFailed),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    hasPin: true,
    minLength: PIN_MIN_LENGTH,
    /** The PIN changed, so any pinned door session is stale — say so plainly. */
    message: "رمز عددی شما تغییر کرد. از این پس با رمز عددی جدید وارد می‌شوید.",
  });
});
