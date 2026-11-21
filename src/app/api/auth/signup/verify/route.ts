/**
 * ESH-200 / #1385 — redeem a signup code.
 *
 * On success the caller is either
 *  - a brand-new personal identity: an encrypted onboarding cookie is set and
 *    they continue to the short business onboarding (#1387), or
 *  - an existing verified account: no duplicate is created and they are told to
 *    sign in. That fact is only revealed *after* they proved control of the
 *    number, so it is their own information, not an enumeration oracle.
 *
 * No tenant session is minted here. A person without a business has nothing to
 * scope a tenant session to, and verifying a phone must never provision one.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySignupOtp } from "@/lib/iam/public-signup";
import {
  ONBOARDING_COOKIE,
  onboardingCookieOptions,
  signOnboardingToken,
} from "@/lib/iam/onboarding-session";

export async function POST(request: NextRequest) {
  let body: { firstName?: unknown; lastName?: unknown; phone?: unknown; code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await verifySignupOtp(body);
  const noStore = (res: NextResponse) => {
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  if (!result.ok) {
    const status =
      result.error === "signup_disabled" ? 403 : result.error === "account_ambiguous" ? 409 : 401;
    return noStore(NextResponse.json(result, { status }));
  }

  if (!result.created) {
    return noStore(
      NextResponse.json({
        ok: true,
        created: false,
        /** Their own account, proven by the code they just redeemed. */
        next: "/login",
        message: "account_exists",
      }),
    );
  }

  const token = await signOnboardingToken(result.platformUserId);
  const res = NextResponse.json({
    ok: true,
    created: true,
    next: "/onboarding",
  });
  res.cookies.set(ONBOARDING_COOKIE, token, onboardingCookieOptions());
  return noStore(res);
}
