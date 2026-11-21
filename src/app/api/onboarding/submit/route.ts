/**
 * ESH-202 / #1387 → #1239 — submit the short onboarding and enter `/setup`.
 *
 * This is the one place the journey creates a tenant, and it does so only after
 * the required business details exist. On success the caller receives the normal
 * tenant session (the same `employee_sessions` row + signed cookie every other
 * door mints) and the onboarding continuation is cleared. `/setup` then opens on
 * the business profile step, which reads the values just persisted — so the
 * owner reviews and completes them rather than typing them again.
 *
 * No app is activated, no subscription or wallet row is written, and setup is
 * not marked complete: that remains #1239's explicit Finish.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import { submitOnboarding } from "@/lib/iam/onboarding";
import {
  ONBOARDING_COOKIE,
  onboardingCookieOptions,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";

export async function POST(request: NextRequest) {
  const platformUserId = await readOnboardingIdentity(
    request.cookies.get(ONBOARDING_COOKIE)?.value ?? null,
  );
  if (!platformUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await submitOnboarding(platformUserId);
  if (!result.ok) {
    const status = result.error === "onboarding_incomplete" ? 409 : 400;
    return NextResponse.json(result, { status });
  }

  const business = result.business;
  const userAgent = request.headers.get("user-agent");
  const opened = await withTenant(business.businessId, () =>
    createSession(business.userId, business.businessId, {
      locationId: business.locationId,
      loginMethod: "setup",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    }),
  ).catch((error: unknown) => {
    console.error(
      "onboarding could not open the Owner's session:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  });

  const res = NextResponse.json({
    ok: true,
    business: {
      id: business.businessId,
      slug: business.businessSlug,
      subdomain: business.businessSubdomain,
    },
    /** The business exists; if the session could not open, sign in at /login. */
    signedIn: opened !== null,
    next: opened ? "/setup" : "/login",
  });

  if (opened) {
    res.cookies.set(
      SESSION_COOKIE,
      await signSession({
        sub: business.userId,
        role: "owner",
        businessId: business.businessId,
        businessSlug: business.businessSlug,
        businessSubdomain: business.businessSubdomain,
        locationId: business.locationId,
        fullName: business.ownerName,
        platformUserId: business.platformUserId,
        employeeSessionId: opened.session.id,
      }),
      sessionCookieOptions(),
    );
  }

  // Done: the continuation must not survive the session it earned.
  res.cookies.set(ONBOARDING_COOKIE, "", { ...onboardingCookieOptions(), maxAge: 0 });
  return res;
}
