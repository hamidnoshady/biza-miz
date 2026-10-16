import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import {
  EmailPasswordMismatchError,
  provisionBusiness,
  publicSignupEnabled,
  validateProvisionBody,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";

/**
 * Self-service business registration.
 *
 * An email that already belongs to the platform may create a further business
 * — that is the cross-business identity case — but must supply its existing
 * password, since adding a business to an account is an action on that
 * account. `provisionBusiness` enforces it.
 *
 * The new Owner's session is revocable like every other (#854 follow-up,
 * third pass): an `employee_sessions` row with `login_method = 'setup'`, named
 * by the cookie. If that row cannot be opened the business still exists, so
 * the answer is still `ok` — with `signedIn: false` and no cookie — rather than
 * a 500 that would invite a second signup (and, with the same password, a
 * second business). The Owner signs in at /login.
 */
export async function POST(request: NextRequest) {
  if (!publicSignupEnabled()) {
    return NextResponse.json({ error: "signup_disabled" }, { status: 403 });
  }

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const validated = validateProvisionBody(body);
  if (!validated.input) return NextResponse.json({ error: validated.error }, { status: 400 });
  const input = validated.input;

  let created;
  try {
    created = await provisionBusiness(input);
    await autoProvisionBusinessVirtualKey(created.businessId);
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      // The email exists and the password didn't match. Deliberately the same
      // response either way would be unhelpful here — the caller is creating
      // an account, not authenticating — but it must not confirm more than
      // "these credentials don't go together".
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
      "signup could not open the Owner's session:",
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
    business: { id: created.businessId, slug: created.businessSlug },
  });
  if (token) res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
