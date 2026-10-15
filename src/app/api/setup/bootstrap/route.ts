import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import {
  EmailPasswordMismatchError,
  provisionBusiness,
  validateProvisionBody,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { hasAnyUser } from "@/lib/setup-state";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";

/**
 * First-run bootstrap: on a completely empty database, creates the business,
 * its first location, and the Owner account in one step, then signs the Owner
 * in so the wizard can continue.
 *
 * Still refuses once any user exists. Phase 12 made a deployment capable of
 * holding many businesses, but adding one is a deliberate act — either a
 * super-admin provisioning it (Phase 15) or public signup, which is off unless
 * explicitly enabled (see /api/setup/signup). Leaving this route open would
 * have turned every install into an open registration endpoint by accident.
 *
 * The Owner's first session is revocable like every other (#854 follow-up,
 * third pass): an `employee_sessions` row with `login_method = 'setup'`, named
 * by the cookie. By the time it is opened the business exists and the second
 * factor below has been minted — and is shown exactly once — so a failure to
 * open the row must not become a 500 that loses both: the answer still carries
 * the factor, with `signedIn: false` and no cookie, and the wizard sends the
 * Owner to the sign-in page instead.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The first-run wizard's mode choice. Anything other than the literal
  // 'local' is treated as connected, which is what every non-desktop caller
  // (public signup, the platform console) already sends by omission.
  const deploymentMode =
    (body as { deploymentMode?: unknown }).deploymentMode === "local" ? "local" : "connected";

  // Resolved before validation, not after: Phase 24 makes the Owner's mobile
  // required on a connected install (it is where their SMS second factor is
  // sent) and pointless on a local one, which enrols TOTP instead. Passing the
  // mode is what lets the validator tell those two cases apart.
  const validated = validateProvisionBody(body, { deploymentMode });
  if (!validated.input) return NextResponse.json({ error: validated.error }, { status: 400 });
  const input = validated.input;

  let created;
  try {
    created = await provisionBusiness({ ...input, deploymentMode });
    await autoProvisionBusinessVirtualKey(created.businessId);
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      return NextResponse.json({ error: "email_password_mismatch" }, { status: 409 });
    }
    throw err;
  }

  const userAgent = request.headers.get("user-agent");
  const opened = await withTenant(created.businessId, () =>
    createSession(created.userId, created.businessId, {
      locationId: null,
      loginMethod: "setup",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    }),
  ).catch((err: unknown) => {
    console.error(
      "first-run bootstrap could not open the Owner's session:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  });
  const token = opened
    ? await signSession({
        sub: created.userId,
        role: "owner",
        businessId: created.businessId,
        businessSlug: created.businessSlug,
        businessSubdomain: created.businessSubdomain,
        locationId: null,
        fullName: input.ownerName,
        platformUserId: created.platformUserId,
        employeeSessionId: opened.session.id,
      })
    : null;
  const res = NextResponse.json({
    ok: true,
    /** False only when the business exists but its Owner could not be signed in: go to /login. */
    signedIn: token !== null,
    // Phase 24 Wave 2 — the Owner's second factor, returned exactly once.
    //
    // `provisionBusiness` enrols TOTP on a local install (no internet, so no
    // SMS) and mints ten recovery codes on both paths. Nothing else can ever
    // show these values again: the TOTP secret is stored encrypted and the
    // recovery codes only as bcrypt hashes. The wizard's last step displays
    // them, and that is the entire window in which they exist.
    mfa: {
      method: created.totpSecret ? ("totp" as const) : ("sms_otp" as const),
      totpSecret: created.totpSecret ?? null,
      totpUrl: created.totpUrl ?? null,
      totpQr: created.totpQr ?? null,
      recoveryCodes: created.recoveryCodes ?? [],
    },
  });
  if (token) res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
