import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import { businessHost } from "@/lib/host";
import { membershipBlockedReason, membershipsForPlatformUser } from "@/lib/memberships";
import { isPasswordRole } from "@/lib/team";
import {
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";

interface PlatformUserRow extends Record<string, unknown> {
  id: string;
  password_hash: string;
  is_active: boolean;
}

/** A bcrypt hash of nothing in particular, used to keep timing uniform. */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/**
 * The apex host's "which business?" router (Phase 23 Wave 3).
 *
 * Under subdomain routing every business has its own origin, so a person with
 * memberships in several needs somewhere to find out which host to go to. The
 * apex `pos.eshobe.com` is that somewhere, and this is what it asks.
 *
 * It mints no session and sets no cookie — that is the point. A session is
 * only ever created on the business's own origin, which is what makes the
 * cookie host-scoped there. This route answers a question and hands back
 * links; the visitor then logs in again on the host they pick.
 *
 * **It asks for the password even though it authenticates nothing.** The plan
 * for this wave described an email-only lookup, and email-only would make this
 * an open account-enumeration oracle: type any address, learn whether it has
 * memberships and at which businesses, from an unauthenticated public origin.
 * Requiring the password costs the visitor one field they were about to type
 * anyway, and matches what /api/auth/login already does — it, too, reveals the
 * business list only after the password checks out. A wave whose whole purpose
 * is tightening the tenant boundary should not open a directory next to it.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";

  return withoutTenantScope("login", async () => {
    const { rows } = await query<PlatformUserRow>(
      `SELECT id, password_hash, is_active FROM platform_users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );

    // Same dummy-hash comparison as /api/auth/login: a wrong email and a wrong
    // password must cost the same time, or the timing is the oracle instead.
    const identity = rows[0]?.is_active ? rows[0] : null;
    const passwordOk = await bcrypt.compare(password, identity?.password_hash ?? DUMMY_HASH);

    // A wrong password answers 401 whether or not the account is locked; the
    // lockout is disclosed only after the password proves the caller owns the
    // account. Same ordering as /api/auth/login and /api/platform/auth/login.
    if (!identity || !passwordOk) {
      await recordAuthFailure("directory", email.trim().toLowerCase());
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const lockout = await checkAuthLockout("directory", email.trim().toLowerCase(), PASSWORD_LOCKOUT_POLICY);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "account_locked", lockedUntil: lockout.lockedUntil },
        { status: 423 },
      );
    }

    await recordAuthSuccess("directory", email.trim().toLowerCase());

    const usable = (await membershipsForPlatformUser(identity.id)).filter(
      (m) => membershipBlockedReason(m) === null,
    );

    return NextResponse.json({
      businesses: usable.map((m) => {
        let url: string | null = null;
        if (rootDomain) {
          const origin = `https://${businessHost(m.businessSubdomain, rootDomain)}`;
          // Since the login split, the origin's root is the staff quick login;
          // the owner/manager/accountant password door is the `/admin`
          // subdirectory. Send each visitor to the door they sign in through.
          url = isPasswordRole(m.role) ? `${origin}/admin` : origin;
        }
        return {
          name: m.businessName,
          subdomain: m.businessSubdomain,
          role: m.role,
          url,
        };
      }),
    });
  });
}
