import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import {
  buildBusinessLogo,
  hasMatchingLogoSignature,
  isLogoMimeType,
  isValidLogo,
} from "@/lib/business-logo";
import { removeOnboardingLogo, saveOnboardingLogo } from "@/lib/onboarding";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * ESH-202 / #1387 — the draft logo.
 *
 * No business exists yet, so this cannot call the tenant-scoped
 * `/api/settings/business/logo` route. It applies that route's exact validation
 * (`isValidLogo` + the canonical media signature check) and stores the same
 * `BusinessLogo` record in the draft. Provisioning copies it into
 * `settings.business.logo`, which is the one place the setup wizard reads.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return noStore({ error: "missing_file" }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isValidLogo({ mimeType: file.type, byteLength: bytes.byteLength })) {
    return noStore({ error: "invalid_logo" }, { status: 400 });
  }
  if (!isLogoMimeType(file.type) || !hasMatchingLogoSignature(file.type, bytes)) {
    return noStore({ error: "invalid_logo" }, { status: 400 });
  }

  const logo = buildBusinessLogo({ mimeType: file.type, bytes });
  const draft = await saveOnboardingLogo(platformUserId, logo);
  return noStore({ ok: true, logo, draft }, { status: 201 });
}

/** Remove the draft logo; "no logo yet" is a valid, completion-preserving choice. */
export async function DELETE() {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) {
    return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
  }
  const draft = await removeOnboardingLogo(platformUserId);
  return noStore({ ok: true, draft });
}
