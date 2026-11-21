/**
 * ESH-202 / #1387 — read and save the short onboarding draft.
 *
 * Authorised by the encrypted onboarding cookie only. Every request re-reads the
 * identity from the database, so a deactivated or unverified person loses access
 * immediately; the row is keyed on that identity, so no request can name another
 * person's draft.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ONBOARDING_STEPS,
  onboardingIndustryOptions,
  readOnboarding,
  saveOnboarding,
} from "@/lib/iam/onboarding";
import {
  ONBOARDING_COOKIE,
  onboardingCookieOptions,
  readOnboardingIdentity,
  signOnboardingToken,
} from "@/lib/iam/onboarding-session";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function identityFrom(request: NextRequest): Promise<string | null> {
  return readOnboardingIdentity(request.cookies.get(ONBOARDING_COOKIE)?.value ?? null);
}

export async function GET(request: NextRequest) {
  const platformUserId = await identityFrom(request);
  if (!platformUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const state = await readOnboarding(platformUserId);
  return NextResponse.json(
    {
      ok: true,
      platformUserId,
      state,
      industries: onboardingIndustryOptions(),
      steps: ONBOARDING_STEPS,
    },
    { headers: NO_STORE },
  );
}

export async function PATCH(request: NextRequest) {
  const platformUserId = await identityFrom(request);
  if (!platformUserId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await saveOnboarding(platformUserId, {
    industry: body.industry,
    businessName: body.businessName,
    locationName: body.locationName,
    address: body.address,
    phone: body.phone,
    logoDataUrl: body.logoDataUrl,
    step: body.step,
    email: body.email,
    nationalId: body.nationalId,
  });

  if (!result.ok) {
    const status = result.error === "already_provisioned" ? 409 : 400;
    return NextResponse.json(result, { status, headers: NO_STORE });
  }

  const res = NextResponse.json({ ok: true, state: result.state }, { headers: NO_STORE });
  // Sliding expiry: every save renews the continuation, so a person who is
  // halfway through a slow form is not signed out of their own draft.
  res.cookies.set(
    ONBOARDING_COOKIE,
    await signOnboardingToken(platformUserId),
    onboardingCookieOptions(),
  );
  return res;
}
