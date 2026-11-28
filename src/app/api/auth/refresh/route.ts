import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { createSession } from "@/lib/employee-service";
import { boundedString, loginErrorMessage } from "@/lib/login-contract";
import { deviceContextFromUserAgent } from "@/lib/login-risk";
import {
  clearedRememberedLoginCookieOptions,
  readRememberedLoginToken,
  rememberedLoginCookieOptions,
  REMEMBERED_LOGIN_COOKIE,
  rotateRememberedLogin,
  type FamilyAssurance,
  type FamilyScope,
  type RememberedRotation,
} from "@/lib/remembered-login";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
} from "@/lib/mfa-service";
import { enrolmentRequirement, mfaAppliesToRole, shouldChallengeMfaOnLogin } from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";
import { readTrustedDeviceToken, verifyTrustedDevice } from "@/lib/trusted-device";
import type { Role } from "@/lib/auth-edge";
import type { SessionLoginMethod } from "@/lib/session-contract";

/**
 * #1585 — renew a remembered login.
 *
 * The only endpoint that turns authority C into authority A. It never extends a
 * JWT's life and never re-signs an expired one: it mints a *new* short-lived
 * session after re-validating everything, which is what lets the access token
 * stay short while a person stays signed in.
 *
 * Public by necessity (there is no session — that is the point), so it is in
 * the middleware's pre-session set and its credential-exchange bucket, and it
 * enforces a same-origin check itself. The credential is an HttpOnly,
 * SameSite=Lax, host-only cookie: unreadable by script, not sent on a
 * cross-site form POST, not sent to another tenant's origin.
 *
 * Responses the client must tell apart:
 *  - `200` — new session cookie and new remembered cookie.
 *  - `409 concurrent_refresh` — another tab rotated microseconds ago; retry.
 *  - `403 step_up_required` — the device context changed and the account's
 *    policy allows a password-only re-proof. Retry with `password`.
 *  - `401 reauth_required` — sign in again at `/login`; the cookie is cleared
 *    because nothing on the server will honour it again.
 */

/** True when the request's `Origin` (if it sent one) is this same origin. */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // A non-browser caller may omit Origin; the cookie is HttpOnly and
    // SameSite=Lax, so this is not a cross-site form post.
    return true;
  }
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

/** Coarse region from a trusted CDN header — never an address, never stored raw. */
function regionHint(request: NextRequest): string | null {
  return request.headers.get("cf-ipcountry") ?? request.headers.get("x-vercel-ip-country") ?? null;
}

function clearAndRefuse(reason: string, status = 401): NextResponse {
  const res = NextResponse.json({ error: "reauth_required", reason }, { status });
  res.cookies.set(REMEMBERED_LOGIN_COOKIE, "", clearedRememberedLoginCookieOptions());
  return res;
}

interface MemberContext {
  role: Role;
  fullName: string;
  locationId: string | null;
  businessName: string;
  businessSlug: string;
  businessSubdomain: string;
}

async function loadMemberContext(
  businessId: string,
  userId: string,
): Promise<MemberContext | null> {
  const { rows } = await withoutTenantScope("login", () =>
    query<Record<string, unknown>>(
      `SELECT u.role, u.full_name, u.location_id, b.name AS business_name,
              b.slug::text AS business_slug, b.subdomain::text AS business_subdomain
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active
          AND b.status = 'active'`,
      [userId, businessId],
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    role: String(row.role) as Role,
    fullName: String(row.full_name),
    locationId: (row.location_id as string | null) ?? null,
    businessName: String(row.business_name),
    businessSlug: String(row.business_slug),
    businessSubdomain: String(row.business_subdomain),
  };
}

/**
 * Does this account's *existing* policy allow a password to stand in for the
 * changed context?
 *
 * Deliberately the password door's own rule, including the trusted-device
 * exemption: if a password login right now would be challenged for a second
 * factor, a password here cannot be stronger than that, and the answer is a
 * full sign-in rather than a downgrade. #1386's protections are untouched —
 * nothing here can make mandatory MFA optional.
 */
async function passwordStepUpAllowed(options: {
  businessId: string;
  userId: string;
  role: string;
  platformUserId: string;
  trustedDeviceToken: string | null;
}): Promise<boolean> {
  const policy = await getMfaPolicy(options.businessId);
  const appliesToRole = mfaAppliesToRole(options.role, policy);
  const active = filterActiveMfaEnrolments(
    await getAccountMfaEnrolments("platform_user", options.platformUserId),
  );
  const graceUntil = await getMfaGracePeriod("platform_user", options.platformUserId);
  const requirement = enrolmentRequirement({
    hasPrimary: active.length > 0,
    graceUntil,
    hasGraceRecord: graceUntil !== null,
    role: options.role,
  });
  const challengeDue = shouldChallengeMfaOnLogin({
    hasConfirmedEnrolment: active.length > 0,
    appliesToRole,
    requirement,
  });
  if (!challengeDue) return true;
  const trust = await verifyTrustedDevice({
    businessId: options.businessId,
    userId: options.userId,
    token: options.trustedDeviceToken,
  });
  return trust.trusted === true;
}

/**
 * Re-prove a changed device context with the account's password.
 *
 * Returns a refusal, or `null` when the retry should proceed.
 */
async function completeStepUp(
  request: NextRequest,
  family: FamilyScope,
  password: string | null,
  trustedDeviceToken: string | null,
): Promise<NextResponse | null> {
  if (!family.platformUserId) return clearAndRefuse("assurance_insufficient");

  const identity = await withoutTenantScope("login", async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT p.email::text AS email, p.phone_e164, p.password_hash, u.role
         FROM users u
         JOIN businesses b ON b.id = u.business_id
         JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active
          AND b.status = 'active' AND p.is_active = true`,
      [family.userId, family.businessId],
    );
    return rows[0] ?? null;
  });
  if (!identity) return clearAndRefuse("membership_lost");

  const allowed = await passwordStepUpAllowed({
    businessId: family.businessId,
    userId: family.userId,
    role: String(identity.role),
    platformUserId: family.platformUserId,
    trustedDeviceToken,
  });
  if (!allowed) {
    // Mandatory MFA applies to this account: a password alone must never
    // satisfy a changed context. Full sign-in.
    return clearAndRefuse("mfa_required");
  }

  if (!password) {
    return NextResponse.json(
      {
        error: "step_up_required",
        allowedMethods: ["password"],
        message: "برای ادامه، رمز عبور خود را دوباره وارد کنید.",
      },
      { status: 403 },
    );
  }

  const lockoutKey = String(identity.email ?? identity.phone_e164 ?? family.platformUserId);
  const lockout = await checkAuthLockout("tenant_password", lockoutKey, PASSWORD_LOCKOUT_POLICY);
  if (lockout.locked) {
    return NextResponse.json(
      { error: "account_locked", lockedUntil: lockout.lockedUntil },
      { status: 423 },
    );
  }
  const ok = await bcrypt.compare(password, String(identity.password_hash ?? ""));
  if (!ok) {
    await recordAuthFailure("tenant_password", lockoutKey);
    return NextResponse.json(
      { error: "invalid_credentials", message: loginErrorMessage({ status: 401 }) },
      { status: 401 },
    );
  }
  await recordAuthSuccess("tenant_password", lockoutKey);
  return null;
}

function sessionFrom(
  family: FamilyScope,
  assurance: FamilyAssurance,
  member: MemberContext,
  employeeSessionId: string,
) {
  return signSession({
    sub: family.userId,
    role: member.role,
    businessId: family.businessId,
    businessSlug: member.businessSlug,
    businessSubdomain: member.businessSubdomain,
    locationId: member.locationId,
    fullName: member.fullName,
    platformUserId: family.platformUserId,
    employeeSessionId,
    /*
     * Assurance is copied from the login that created the family, never raised
     * here. `recentAuthAt` in particular stays at the instant the human proved
     * who they were: a renewal is not an authentication, and moving the clock
     * forward would hand a stale session the recent-auth window that guards
     * sensitive account changes (#1386).
     */
    mfaVerified: assurance.mfaVerified,
    recentAuthAt: Math.floor(assurance.authenticatedAt.getTime() / 1000),
    ...(assurance.otpOnlyAssurance ? { otpOnlyAssurance: true } : {}),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "wrong_origin" }, { status: 403 });
  }

  const secret = readRememberedLoginToken(request);
  if (!secret) {
    return NextResponse.json({ error: "no_remembered_login" }, { status: 401 });
  }

  let body: { password?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is the normal silent-renewal case.
  }
  const password = boundedString(body.password, { max: 72, trim: false, required: false });

  const device = deviceContextFromUserAgent(request.headers.get("user-agent"), regionHint(request));
  const trustedDeviceToken = readTrustedDeviceToken(request);

  let rotation: RememberedRotation = await rotateRememberedLogin({ secret, device });

  if (rotation.status === "concurrent") {
    return NextResponse.json({ error: "concurrent_refresh" }, { status: 409 });
  }
  if (rotation.status === "reauth_required") {
    return clearAndRefuse(rotation.reason);
  }

  if (rotation.status === "step_up_required") {
    const refusal = await completeStepUp(request, rotation.family, password, trustedDeviceToken);
    if (refusal) return refusal;
    // Verified. Rotate with the step-up acknowledged; assurance is still not
    // raised — a password re-proof of a changed context is not a fresh
    // authentication for sensitive actions.
    rotation = await rotateRememberedLogin({ secret, device, stepUpVerified: true });
    if (rotation.status === "concurrent") {
      return NextResponse.json({ error: "concurrent_refresh" }, { status: 409 });
    }
    if (rotation.status !== "rotated") {
      return clearAndRefuse(rotation.status === "reauth_required" ? rotation.reason : "step_up_failed");
    }
  }

  if (rotation.status !== "rotated") {
    return clearAndRefuse("unexpected_state");
  }

  const { family, assurance } = rotation;
  const member = await loadMemberContext(family.businessId, family.userId);
  if (!member) return clearAndRefuse("membership_lost");

  const userAgent = request.headers.get("user-agent");
  const opened = await createSession(family.userId, family.businessId, {
    locationId: member.locationId,
    deviceLabel: userAgent?.slice(0, 120) ?? "Web",
    userAgent: userAgent?.slice(0, 500) ?? null,
    loginMethod: (family.loginMethod as SessionLoginMethod | null) ?? null,
  });

  const res = NextResponse.json({
    ok: true,
    user: { id: family.userId, role: member.role, fullName: member.fullName },
    business: {
      id: family.businessId,
      name: member.businessName,
      slug: member.businessSlug,
    },
    expiresAt: rotation.absoluteExpiresAt.toISOString(),
  });
  res.cookies.set(
    SESSION_COOKIE,
    await sessionFrom(family, assurance, member, opened.session.id),
    sessionCookieOptions(),
  );
  res.cookies.set(
    REMEMBERED_LOGIN_COOKIE,
    rotation.secret,
    rememberedLoginCookieOptions(rotation.absoluteExpiresAt),
  );
  return res;
}
