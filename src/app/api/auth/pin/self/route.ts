import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { AUTH_ERROR_CODES, authErrorMessage } from "@/lib/auth-contracts";
import { PIN_MIN_LENGTH, PIN_POLICY_HINT, isValidPin } from "@/lib/pin-policy";
import { isRecentAuth, requireRecentAuth } from "@/lib/recent-auth";
import { readSelfCredentialState, verifySelfPin } from "@/lib/self-credentials";
import { auditLoginFailure, checkLoginLockout } from "@/lib/employee-service";
import { setPin, TeamError } from "@/lib/team-service";
import { toLatinDigits } from "@/lib/digits";

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
 *  - **the current PIN**, verified here, when one already exists — a
 *    self-service rotation must not be a takeover of a credential the member
 *    still holds. A first-time PIN has nothing to prove against, so the recent
 *    auth requirement is the whole bar;
 *  - **lockout + audit** on a wrong current PIN, reusing the same
 *    `auth_login_attempts` counter the door login uses, so guessing here is
 *    neither free nor invisible;
 *  - **deployment authority** from the shared table: Hybrid and Local may
 *    originate a staff PIN (a till must be able to issue one while the uplink is
 *    down); a `apply`-only deployment may not, and says so with the shared
 *    notice.
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

  let body: { currentPin?: string; newPin?: string; confirmPin?: string };
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
  if (hasExistingPin) {
    const offered = toLatinDigits(String(body.currentPin ?? "").trim());
    if (!offered) {
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.currentPinRequired,
          message: authErrorMessage(AUTH_ERROR_CODES.currentPinRequired),
        },
        { status: 403 },
      );
    }

    const lockout = await checkLoginLockout(session.businessId, session.sub);
    if (lockout.locked) {
      return NextResponse.json(
        { error: AUTH_ERROR_CODES.accountLocked, lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    if (!(await verifySelfPin(session.businessId, session.sub, offered))) {
      await auditLoginFailure(session.businessId, session.sub, "invalid_current_pin_self");
      return NextResponse.json(
        {
          error: AUTH_ERROR_CODES.invalidCurrentPin,
          message: authErrorMessage(AUTH_ERROR_CODES.invalidCurrentPin),
        },
        { status: 401 },
      );
    }
  }

  try {
    await setPin(session.businessId, session.sub, newPin, session.sub, {
      selfService: true,
      currentPinVerified: true,
    });
  } catch (err) {
    if (err instanceof TeamError) {
      /**
       * `TeamError.message` is already a code from the shared vocabulary
       * (`pin_taken`, `login_managed_by_cloud`, …); translating it here keeps
       * the route's body identical to every other credential route's.
       */
      return NextResponse.json(
        { error: err.message, message: authErrorMessage(err.message) },
        { status: err.status },
      );
    }
    throw err;
  }

  // The rotation itself is audited inside `setPin` (`team.self_pin_changed`);
  // this row records the *surface* it came through, so the trail distinguishes
  // a Profile rotation from a door-screen one when an incident is reconstructed
  // (#854 P2.22).
  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, 'auth.self_pin_changed', 'user', $3, $4)`,
    [
      session.businessId,
      session.sub,
      session.sub,
      JSON.stringify({ surface: "settings/profile", hadPin: hasExistingPin }),
    ],
  ).catch(() => {});

  return NextResponse.json({
    ok: true,
    hasPin: true,
    minLength: PIN_MIN_LENGTH,
    /** The PIN changed, so any pinned door session is stale — say so plainly. */
    message: "رمز عددی شما تغییر کرد. از این پس با رمز عددی جدید وارد می‌شوید.",
  });
});
