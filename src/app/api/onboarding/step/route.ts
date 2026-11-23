import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import { saveOnboardingStep, type SaveStepInput } from "@/lib/onboarding";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * ESH-202 / #1387 — save one step of the short onboarding.
 *
 * The platform identity comes only from the encrypted continuation; the body
 * is limited to the step's own values. Every write is an idempotent upsert on
 * `platform_onboarding_drafts`.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }

  let body: Partial<SaveStepInput>;
  try {
    body = (await request.json()) as Partial<SaveStepInput>;
  } catch {
    return noStore({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.step !== "string") {
    return noStore({ error: "invalid_step" }, { status: 400 });
  }

  const result = await saveOnboardingStep(platformUserId, body as SaveStepInput);
  if (!result.ok) {
    const status =
      result.error === "identity_missing"
        ? 401
        : result.error === "email_taken" || result.error === "national_id_taken"
          ? 409
          : result.error === "encryption_unavailable"
            ? 503
            : 400;
    return noStore(result, { status });
  }
  return noStore({
    ok: true,
    draft: result.draft,
    ...(result.emailVerification ? { emailVerification: result.emailVerification } : {}),
  });
}
