import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { createSession } from "@/lib/employee-service";
import { configuredRootDomains, hostRoutingEnabled, parseHostAny, requestHost, type HostEnv } from "@/lib/host";
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
import { boundedString, loginEmailOrNull, uuidOrNull } from "@/lib/login-contract";
import { phoneE164 } from "@/lib/phone";
import {
  auditTrustedDeviceLogin,
  readTrustedDeviceToken,
  revokeTrustedDevicesForPlatformUser,
  verifyTrustedDevice,
} from "@/lib/trusted-device";

interface PlatformUserRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  /** NULL for a passwordless identity: the dummy-hash fallback below fails it closed. */
  password_hash: string | null;
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

  const parsed = parseHostAny(host, configuredRootDomains(process.env as HostEnv));
  if (parsed.kind !== "business") return { businessId: null, error: "wrong_origin" };

  const business = await resolveBusinessByLabel(parsed.label);
  if (!business || business.status !== "active" || business.viaAlias) {
    return { businessId: null, error: "wrong_origin" };
  }
  return { businessId: business.businessId, error: null };
}

export async function POST(request: NextRequest) {
  let body: { email?: unknown; identifier?: unknown; password?: unknown; businessId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Issue #885 L14 — bounded runtime validation before anything reaches a
  // database or bcrypt. The old shape checked truthiness and then called
  // `email.trim()` and `bcrypt.compare(password, …)`, so a truthy non-string
  // (`{"email": 1, "password": []}` — trivial to produce from a form encoder
  // or a hand-rolled client) reached string and crypto methods and threw a 500
  // instead of answering 400.
  //
  // The password ceiling is bcrypt's own: the algorithm only considers the
  // first 72 bytes, so an over-long value must be refused rather than silently
  // truncated into a different credential than the one the user typed.
  // Phase 48 — the cloud account door takes *either* an email or a mobile
  // number. `email` stays accepted so older clients keep working; `identifier`
  // is what the current form sends. A number is only ever looked up as an
  // already-verified phone, so an unverified value typed onto an identity can
  // never be used to claim it here.
  const typed = boundedString(body.identifier, { max: 254 }) ?? boundedString(body.email, { max: 254 });
  const email = loginEmailOrNull(typed);
  const phone = email ? null : phoneE164(typed);
  const password = boundedString(body.password, { max: 72, trim: false });
  const businessId = uuidOrNull(body.businessId);
  if (!email && !phone) {
    return NextResponse.json({ error: "invalid_identifier" }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const hostScope = await loginHostBusinessId(requestHost(request.headers));
  if (hostScope.error) {
    return NextResponse.json({ error: hostScope.error }, { status: 400 });
  }

  return withoutTenantScope("login", async () => {
    // Already canonical: `loginEmailOrNull` trimmed/lower-cased an address and
    // `phoneE164` normalised a number. This is also the lockout key, so the
    // same person is counted the same way whichever spelling they type.
    const lockoutKey = email ?? (phone as string);
    const { rows } = email
      ? await query<PlatformUserRow>(
          `SELECT id, full_name, password_hash, is_active, token_version FROM platform_users WHERE email = $1`,
          [email],
        )
      : await query<PlatformUserRow>(
          // The global identity's verified number, or a membership's verified
          // number linked to it (dual-read while both columns exist). More
          // than one row means the number is genuinely ambiguous on this
          // deployment — refused as a failed credential rather than guessing.
          `SELECT DISTINCT p.id, p.full_name, p.password_hash, p.is_active, p.token_version
             FROM platform_users p
             LEFT JOIN users u ON u.platform_user_id = p.id
            WHERE (p.phone_e164 = $1 AND p.phone_verified_at IS NOT NULL)
               OR (u.phone_e164 = $1 AND u.phone_verified_at IS NOT NULL)`,
          [phone],
        );

    const identity = rows.length === 1 ? rows[0] : undefined;
    const usableIdentity = identity?.is_active ? identity : null;
    // The dummy-hash comparison keeps an unknown email as expensive as a known
    // one, so timing is not the oracle. The lockout verdict is disclosed only
    // below, and only once the password has been proven: a wrong password on a
    // locked account must answer exactly like a wrong password anywhere else
    // (401 invalid_credentials), or the 423 status itself enumerates locked
    // accounts to a caller who never had the password.
    const passwordOk = await bcrypt.compare(password, usableIdentity?.password_hash ?? DUMMY_HASH);

    if (!usableIdentity || !passwordOk) {
      await recordAuthFailure("tenant_password", lockoutKey);
      // Issue #885 — the failure that locks the account takes back its trusted
      // devices. The lockout is read for unknown addresses too, so the response
      // time does not tell a caller whether the address exists.
      const afterFailure = await checkAuthLockout(
        "tenant_password",
        lockoutKey,
        PASSWORD_LOCKOUT_POLICY,
      );
      if (afterFailure.locked && usableIdentity) {
        await revokeTrustedDevicesForPlatformUser({
          platformUserId: usableIdentity.id,
          reason: "account_locked",
        });
      }
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const lockout = await checkAuthLockout(
      "tenant_password",
      lockoutKey,
      PASSWORD_LOCKOUT_POLICY,
    );
    if (lockout.locked) {
      // Password proven, so telling this caller the account is locked is
      // actionable rather than a leak.
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    await recordAuthSuccess("tenant_password", lockoutKey);

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

    const chosen = businessId
      ? usable.find((m) => m.businessId === businessId)
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
    const requiresMfa = mfaAppliesToRole(chosen.role, mfaPolicy);

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

      // Issue #885 — the seven-day trusted-device exemption.
      //
      // The password was just proven above, so this waives only the *second*
      // factor: an approved primary credential was presented on every login,
      // and the membership, business and global identity were all re-read
      // fresh before this point. A device that completed a full verification
      // (password plus this MFA) and was explicitly trusted inside the last
      // seven days is not asked for the second factor again.
      //
      // Scoped to this business and this membership, so the same account on a
      // different tenant, or a different account on this device, is a miss and
      // falls through to the challenge below. Only consulted when a challenge
      // is actually due — on a device with no MFA requirement there is nothing
      // to waive and no query to spend.
      const challengeDue = shouldChallengeMfaOnLogin({
        hasConfirmedEnrolment: activeEnrolments.length > 0,
        appliesToRole: requiresMfa,
        requirement: req,
      });
      const deviceTrust = challengeDue
        ? await verifyTrustedDevice({
            businessId: chosen.businessId,
            userId: chosen.userId,
            token: readTrustedDeviceToken(request),
          })
        : null;

      if (challengeDue && deviceTrust?.trusted !== true) {
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

      // A skipped second factor is recorded before the session exists, and a
      // failed write refuses the login rather than letting it pass unlogged.
      if (challengeDue && deviceTrust?.trusted === true) {
        await withTenant(chosen.businessId, () =>
          auditTrustedDeviceLogin({
            businessId: chosen.businessId,
            userId: chosen.userId,
            platformUserId: usableIdentity.id,
            door: "password",
            waived: "mfa",
            expiresAt: deviceTrust.expiresAt,
          }),
        );
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
        // The door, for the device list and the security center (P2.27).
        loginMethod: "password",
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
