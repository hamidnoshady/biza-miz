import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { createSession } from "@/lib/employee-service";
import { hostRoutingEnabled, parseHost, requestHost, rootDomain } from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  membershipBlockedReason,
  membershipsForPlatformUser,
  type Membership,
} from "@/lib/memberships";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  markMfaGracePeriod,
  signMfaPendingToken,
} from "@/lib/mfa-service";
import {
  enrolmentRequirement,
  graceDaysRemaining,
  mfaAppliesToRole,
  MFA_GRACE_DAYS_TENANT,
  shouldChallengeMfaOnLogin,
} from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";

interface PlatformUserRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  token_version: number;
}

/** A bcrypt hash of nothing in particular, used to keep timing uniform. */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

async function sessionFor(
  membership: Membership,
  platformUserId: string,
  tokenVersion: number,
  employeeSessionId: string,
) {
  return signSession({
    sub: membership.userId,
    role: membership.role,
    businessId: membership.businessId,
    businessSlug: membership.businessSlug,
    businessSubdomain: membership.businessSubdomain,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId,
    tokenVersion,
    employeeSessionId,
    mfaVerified: false,
    recentAuthAt: Math.floor(Date.now() / 1000),
  });
}

async function loginHostBusinessId(
  host: string | null,
): Promise<{ businessId: string | null; error: string | null }> {
  if (!hostRoutingEnabled()) return { businessId: null, error: null };

  const parsed = parseHost(host, rootDomain());
  if (parsed.kind !== "business") return { businessId: null, error: "wrong_origin" };

  const business = await resolveBusinessByLabel(parsed.label);
  if (!business || business.status !== "active" || business.viaAlias) {
    return { businessId: null, error: "wrong_origin" };
  }
  return { businessId: business.businessId, error: null };
}

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const hostScope = await loginHostBusinessId(requestHost(request.headers));
  if (hostScope.error) {
    return NextResponse.json({ error: hostScope.error }, { status: 400 });
  }

  return withoutTenantScope("login", async () => {
    const normalizedEmail = email.trim().toLowerCase();
    const { rows } = await query<PlatformUserRow>(
      `SELECT id, full_name, password_hash, is_active, token_version FROM platform_users WHERE email = $1`,
      [normalizedEmail],
    );

    const identity = rows[0];
    const usableIdentity = identity?.is_active ? identity : null;
    const passwordOk = await bcrypt.compare(password, usableIdentity?.password_hash ?? DUMMY_HASH);

    const lockout = await checkAuthLockout(
      "tenant_password",
      normalizedEmail,
      PASSWORD_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    if (!usableIdentity || !passwordOk) {
      await recordAuthFailure("tenant_password", normalizedEmail);
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    await recordAuthSuccess("tenant_password", normalizedEmail);

    const memberships = await membershipsForPlatformUser(usableIdentity.id);
    if (memberships.length === 0) {
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const allUsable = memberships.filter((m) => membershipBlockedReason(m) === null);
    if (allUsable.length === 0) {
      return NextResponse.json(
        { error: "business_unavailable", reason: membershipBlockedReason(memberships[0]) },
        { status: 403 },
      );
    }

    const usable = hostScope.businessId
      ? allUsable.filter((m) => m.businessId === hostScope.businessId)
      : allUsable;
    if (usable.length === 0) {
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const chosen = body.businessId
      ? usable.find((m) => m.businessId === body.businessId)
      : usable.length === 1
        ? usable[0]
        : undefined;

    if (!chosen) {
      return NextResponse.json({
        needsBusinessSelection: true,
        businesses: usable.map((m) => ({
          id: m.businessId,
          name: m.businessName,
          slug: m.businessSlug,
          role: m.role,
        })),
      });
    }

    await query(`UPDATE platform_users SET last_login_at = now() WHERE id = $1`, [
      usableIdentity.id,
    ]);

    const mfaPolicy = await getMfaPolicy(chosen.businessId);
    const requiresMfa = mfaAppliesToRole(chosen.role, mfaPolicy.requireForManagers);

    let graceNotice: {
      mfaState: "grace";
      graceUntil: string | null;
      graceDaysLeft: number | null;
    } | null = null;

    const allEnrolments = await getAccountMfaEnrolments("platform_user", usableIdentity.id);
    const activeEnrolments = filterActiveMfaEnrolments(allEnrolments);
    const primaryEnrolment = activeEnrolments[0] ?? null;

    if (requiresMfa || activeEnrolments.length > 0) {
      let graceUntil = await getMfaGracePeriod("platform_user", usableIdentity.id);
      const hasGraceRecord = graceUntil !== null;

      if (requiresMfa && !hasGraceRecord && activeEnrolments.length === 0) {
        await markMfaGracePeriod("platform_user", usableIdentity.id, MFA_GRACE_DAYS_TENANT);
        graceUntil = await getMfaGracePeriod("platform_user", usableIdentity.id);
      }

      const mfaState = {
        hasPrimary: activeEnrolments.length > 0,
        graceUntil,
        hasGraceRecord,
        role: chosen.role,
      };

      const req = enrolmentRequirement(mfaState);

      if (
        shouldChallengeMfaOnLogin({
          hasConfirmedEnrolment: activeEnrolments.length > 0,
          appliesToRole: requiresMfa,
          requirement: req,
        })
      ) {
        const mfaToken = await signMfaPendingToken({
          sub: usableIdentity.id,
          method: primaryEnrolment ? primaryEnrolment.method : null,
          authRealm: "tenant_password",
          businessId: chosen.businessId,
          primaryAuth: "password",
        });

        return NextResponse.json({
          mfaRequired: true,
          mfaState: req,
          mfaToken,
          mfaMethod: primaryEnrolment ? primaryEnrolment.method : null,
          availableMethods: activeEnrolments.map((e) => e.method),
        });
      }

      if (requiresMfa && req === "grace") {
        graceNotice = {
          mfaState: "grace",
          graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
          graceDaysLeft: graceDaysRemaining(graceUntil),
        };
      }
    }

    const { session: empSession } = await withTenant(chosen.businessId, () =>
      createSession(chosen.userId, chosen.businessId, {
        locationId: chosen.locationId,
        deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? "Web (Password)",
      }),
    );

    const res = NextResponse.json({
      user: { id: chosen.userId, role: chosen.role, fullName: chosen.fullName },
      business: { id: chosen.businessId, name: chosen.businessName, slug: chosen.businessSlug },
      ...(graceNotice ?? {}),
    });
    res.cookies.set(
      SESSION_COOKIE,
      await sessionFor(chosen, usableIdentity.id, usableIdentity.token_version, empSession.id),
      sessionCookieOptions(),
    );
    return res;
  });
}
