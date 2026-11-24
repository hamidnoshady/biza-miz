/**
 * ESH-200 / #1385 — redeem a signup code.
 *
 * On success the caller is either:
 *
 *  - a brand-new personal identity with no business: an encrypted, short-lived
 *    onboarding continuation cookie is set and they continue to the #1387
 *    onboarding entry point, or
 *  - an existing verified identity: no duplicate is created. If they already
 *    belong to a business, they are sent to sign in; if they have not started a
 *    business yet, the same continuation lets them resume onboarding. That fact
 *    is only revealed *after* they proved control of the number, so it is their
 *    own information, not an enumeration oracle.
 *
 * No tenant session is minted here. A person without a business has nothing to
 * scope one to, and verifying a phone must never provision one.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySignupOtp } from "@/lib/iam/public-signup";
import {
  ONBOARDING_COOKIE,
  onboardingCookieOptions,
  signOnboardingToken,
} from "@/lib/iam/onboarding-session";

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: NextRequest) {
  let body: {
    firstName?: unknown;
    lastName?: unknown;
    phone?: unknown;
    code?: unknown;
    requestToken?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
  }

  const result = await verifySignupOtp(body);
  if (!result.ok) {
    const status =
      result.error === "signup_disabled" || result.error === "signup_maintenance"
        ? 403
        : result.error === "account_ambiguous"
          ? 409
          : result.error === "account_unavailable"
            ? 409
            : 401;
    return noStore(NextResponse.json(result, { status }));
  }

  if (result.hasBusinessMemberships) {
    const res = noStore(
      NextResponse.json({
        ok: true,
        created: result.created,
        resumed: result.resumed,
        /** Their own account, proven by the code they just redeemed. */
        next: "/login",
        message: "account_exists",
      }),
    );
    // A stale continuation must not survive a sign-in path.
    res.cookies.delete(ONBOARDING_COOKIE);
    return res;
  }

  let token: string;
  try {
    token = await signOnboardingToken(result.platformUserId);
  } catch (error) {
    // The identity is already committed. The person can retry the same verify
    // inside the idempotency window, or request a fresh code, so this is a
    // recoverable failure rather than a half-created account.
    console.error("[signup] could not issue the onboarding continuation", {
      platformUserId: result.platformUserId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return noStore(
      NextResponse.json(
        { error: "continuation_failed", message: "onboarding_continuation_failed" },
        { status: 500 },
      ),
    );
  }

  const res = noStore(
    NextResponse.json({
      ok: true,
      created: result.created,
      resumed: result.resumed,
      next: "/onboarding",
    }),
  );
  res.cookies.set(ONBOARDING_COOKIE, token, onboardingCookieOptions());
  return res;
}
