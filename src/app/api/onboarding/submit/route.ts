import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import { submitOnboarding } from "@/lib/onboarding";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * ESH-202 / #1387 — confirmation-gated provisioning and the handoff to #1239.
 *
 * The business is created by the canonical provisioning service only here,
 * after the review step. The draft's advisory lock and `provisioned_business_id`
 * make a retry or a second tab return the same business. The tenant session is
 * minted only after the business exists, exactly as the existing self-service
 * signup route does, and the encrypted onboarding continuation is then spent.
 *
 * Nothing here selects an app, starts a subscription, funds a wallet, requests a
 * charge or marks the #1239 setup complete.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }

  const result = await submitOnboarding(platformUserId);
  if (!result.ok) {
    const status =
      result.error === "identity_missing"
        ? 401
        : result.error === "not_started" ||
            result.error === "memberships_exist" ||
            result.error === "email_taken"
          ? 409
          : 400;
    const body =
      result.error === "memberships_exist"
        ? { ...result, next: "/login" }
        : result;
    return noStore(body, { status });
  }

  if (!result.alreadyProvisioned) {
    // Canonical post-provisioning hook used by the existing signup/bootstrap
    // doors. It is best-effort and owns no tenant data of its own.
    await autoProvisionBusinessVirtualKey(result.businessId);
  }

  const userAgent = request.headers.get("user-agent");
  const opened = await withTenant(result.businessId, () =>
    createSession(result.userId, result.businessId, {
      locationId: result.locationId || null,
      loginMethod: "setup",
      deviceLabel: userAgent?.slice(0, 120) ?? null,
      userAgent,
    }),
  ).catch((error: unknown) => {
    console.error(
      "short onboarding could not open the owner session:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  });

  const token = opened
    ? await signSession({
        sub: result.userId,
        role: "owner",
        businessId: result.businessId,
        businessSlug: result.businessSlug,
        businessSubdomain: result.businessSubdomain,
        locationId: result.locationId || null,
        fullName: result.ownerName,
        platformUserId: result.platformUserId,
        employeeSessionId: opened.session.id,
        mfaVerified: false,
        recentAuthAt: Math.floor(Date.now() / 1000),
      })
    : null;

  const res = noStore({
    ok: true,
    signedIn: token !== null,
    business: {
      id: result.businessId,
      slug: result.businessSlug,
      subdomain: result.businessSubdomain,
    },
    next: token ? "/setup/business" : "/login?next=/setup/business",
    alreadyProvisioned: result.alreadyProvisioned,
  });

  if (token) {
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    // The continuation is a door, not a session: once the tenant session exists
    // it must not survive a logout or a switch to another business.
    res.cookies.delete(ONBOARDING_COOKIE);
  }
  return res;
}
