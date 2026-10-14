import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import {
  createPlatformAdminSession,
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  signPlatformSession,
  type PlatformAdminRole,
} from "@/lib/platform-auth";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "@/lib/login-lockout";
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
  MFA_GRACE_DAYS_PLATFORM,
  shouldChallengeMfaOnLogin,
} from "@/lib/mfa";

interface PlatformAdminRow extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  role: PlatformAdminRole;
  token_version: number;
}

const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<PlatformAdminRow>(
      `SELECT id, email::text AS email, full_name, password_hash, is_active, role::text AS role, token_version
         FROM platform_admins WHERE email = $1`,
      [email],
    );

    const admin = rows[0];
    const usable = admin?.is_active ? admin : null;
    const ok = await bcrypt.compare(password, usable?.password_hash ?? DUMMY_HASH);

    // Anti-enumeration: while the password is unproven, a locked admin account
    // answers exactly like a wrong password. The lockout verdict is only
    // actionable once the password itself checked out. Same ordering as the
    // tenant and directory doors.
    if (!usable || !ok) {
      await recordAuthFailure("platform_admin", email);
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const lockout = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    await recordAuthSuccess("platform_admin", email);

    await query(`UPDATE platform_admins SET last_login_at = now() WHERE id = $1`, [usable.id]);

    const allEnrolments = await getAccountMfaEnrolments("platform_admin", usable.id);
    const activeEnrolments = filterActiveMfaEnrolments(allEnrolments);
    const primaryEnrolment = activeEnrolments[0] ?? null;

    let graceUntil = await getMfaGracePeriod("platform_admin", usable.id);
    const hasGraceRecord = graceUntil !== null;

    if (!hasGraceRecord && activeEnrolments.length === 0) {
      await markMfaGracePeriod("platform_admin", usable.id, MFA_GRACE_DAYS_PLATFORM);
      graceUntil = await getMfaGracePeriod("platform_admin", usable.id);
    }

    const mfaState = {
      hasPrimary: activeEnrolments.length > 0,
      graceUntil,
      hasGraceRecord,
      role: usable.role,
    };

    const req = enrolmentRequirement(mfaState);

    if (
      shouldChallengeMfaOnLogin({
        hasConfirmedEnrolment: activeEnrolments.length > 0,
        appliesToRole: true,
        requirement: req,
      })
    ) {
      const mfaToken = await signMfaPendingToken({
        sub: usable.id,
        method: primaryEnrolment ? primaryEnrolment.method : null,
        authRealm: "platform_admin",
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

    const sessionId = await createPlatformAdminSession({
      adminId: usable.id,
      tokenVersion: usable.token_version,
      mfaVerified: false,
      deviceLabel: request.headers.get("user-agent")?.slice(0, 120) ?? "Console",
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });

    const token = await signPlatformSession({
      padmin: usable.id,
      role: usable.role,
      fullName: usable.full_name,
      email: usable.email,
      tokenVersion: usable.token_version,
      mfaVerified: false,
      recentAuthAt: Math.floor(Date.now() / 1000),
      sessionId,
    });

    const res = NextResponse.json({
      admin: { id: usable.id, fullName: usable.full_name, role: usable.role },
      ...(req === "grace"
        ? {
            mfaState: "grace" as const,
            graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
            graceDaysLeft: graceDaysRemaining(graceUntil),
          }
        : {}),
    });
    res.cookies.set(PLATFORM_SESSION_COOKIE, token, platformSessionCookieOptions());
    return res;
  });
}
