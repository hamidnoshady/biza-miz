import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import { loadOnboardingState } from "@/lib/onboarding";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * ESH-202 / #1387 — the short onboarding state.
 *
 * The encrypted continuation (not a tenant session) names the person. The
 * cookie is re-validated against `platform_users` on every request, and the
 * response never contains a national ID or an email-proof token.
 */
export async function GET() {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }

  const state = await loadOnboardingState(platformUserId);
  if (!state) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }

  // A person who joined a business after signup must use the ordinary sign-in
  // chooser, not create a second business from this draft.
  if (state.membershipsExist && !state.provisioned) {
    return noStore({ error: "memberships_exist", next: "/login" }, { status: 409 });
  }

  return noStore(state);
}
