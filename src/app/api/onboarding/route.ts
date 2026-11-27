import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";
import {
  loadOnboardingState,
  removeOnboardingLogo,
  saveOnboardingLogo,
  saveOnboardingStep,
  submitOnboarding,
  type SaveStepInput,
} from "@/lib/onboarding";
import {
  buildBusinessLogo,
  hasMatchingLogoSignature,
  isLogoMimeType,
  isValidLogo,
} from "@/lib/business-logo";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";
import { loadSignupGate, signupGateError } from "@/lib/iam/signup-controls";
import { recordSignupEvent } from "@/lib/iam/signup-events";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function continuationIdentity(): Promise<string | null> {
  const cookieStore = await cookies();
  return readOnboardingIdentity(cookieStore.get(ONBOARDING_COOKIE)?.value);
}

function unauthorized(): NextResponse {
  return noStore({ error: "continuation_invalid", next: "/login" }, { status: 401 });
}

/**
 * ESH-202 / #1387 — the short onboarding API.
 *
 * One route, four actions: `GET` reads state, `POST` with `action: "step"`
 * saves a step, `POST` multipart uploads the draft logo, `POST` with
 * `action: "submit"` provisions once and hands off to /setup, and `DELETE`
 * removes the draft logo. Keeping the actions together avoids a new
 * client-reference manifest per verb while the identity rule stays the same:
 * only the encrypted continuation names the person.
 */
export async function GET() {
  const platformUserId = await continuationIdentity();
  if (!platformUserId) return unauthorized();

  const state = await loadOnboardingState(platformUserId);
  if (!state) return unauthorized();

  // A person who joined a business after signup must use the ordinary sign-in
  // chooser, not create a second business from this draft.
  if (state.membershipsExist && !state.provisioned) {
    return noStore({ error: "memberships_exist", next: "/login" }, { status: 409 });
  }

  return noStore(state);
}

export async function POST(request: Request) {
  const platformUserId = await continuationIdentity();
  if (!platformUserId) return unauthorized();

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return uploadLogo(request, platformUserId);
  }

  let body: { action?: unknown } & Partial<SaveStepInput>;
  try {
    body = (await request.json()) as { action?: unknown } & Partial<SaveStepInput>;
  } catch {
    return noStore({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "step") {
    if (typeof body.step !== "string") {
      return noStore({ error: "invalid_step" }, { status: 400 });
    }
    const result = await saveOnboardingStep(platformUserId, body as SaveStepInput);
    if (!result.ok) return stepError(result);
    return noStore({
      ok: true,
      draft: result.draft,
      ...(result.emailVerification ? { emailVerification: result.emailVerification } : {}),
    });
  }

  if (body.action === "submit") {
    return submit(request, platformUserId);
  }

  return noStore({ error: "invalid_action" }, { status: 400 });
}

/** Remove the draft logo; "no logo yet" is a valid, completion-preserving choice. */
export async function DELETE() {
  const platformUserId = await continuationIdentity();
  if (!platformUserId) return unauthorized();
  const draft = await removeOnboardingLogo(platformUserId);
  return noStore({ ok: true, draft });
}

type SaveStepFailure = Extract<
  Awaited<ReturnType<typeof saveOnboardingStep>>,
  { ok: false }
>;

function stepError(result: SaveStepFailure): NextResponse {
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

async function uploadLogo(request: Request, platformUserId: string): Promise<NextResponse> {
  const form = await request.formData().catch(() => null);
  if (!form || form.get("action") !== "logo") {
    return noStore({ error: "invalid_action" }, { status: 400 });
  }
  const file = form.get("file");
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

async function submit(request: Request, platformUserId: string): Promise<NextResponse> {
  // Issue #1388 — a maintenance pause or an administrative disable covers the
  // complete public signup flow, including the provisioning act at its end.
  // The draft survives, so the person can resume once registration reopens.
  const gate = await loadSignupGate();
  if (!gate.enabled) {
    return noStore(
      {
        error: signupGateError(gate.reason),
        reason: gate.reason,
        next: "/signup",
        message:
          gate.reason === "maintenance"
            ? "ثبت‌نام موقتاً متوقف شده است. پیشرفت شما ذخیره شده و پس از بازشدن دوباره ادامه می‌دهید."
            : "ساخت کسب‌وکار در حال حاضر ممکن نیست. برای راهنمایی با پشتیبانی تماس بگیرید.",
      },
      { status: 403 },
    );
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
    // Issue #1388 — the funnel's two closing facts. Best-effort and ids only;
    // a retry of an already-provisioned draft does not double count.
    await recordSignupEvent({
      event: "onboarding_completed",
      platformUserId,
      businessId: result.businessId,
    });
    await recordSignupEvent({
      event: "business_provisioned",
      platformUserId,
      businessId: result.businessId,
    });
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
        // #1386 — the continuation was proved by the signup SMS OTP alone.
        otpOnlyAssurance: true,
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
