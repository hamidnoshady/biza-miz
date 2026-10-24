import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { createSession } from "@/lib/employee-service";
import {
  EmailPasswordMismatchError,
  provisionBusiness,
  validateProvisionBody,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { isIndustry, type Industry } from "@/lib/industries";
import { hasAnyUser } from "@/lib/setup-state";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";
import {
  commitLocalActivationRecordAndAcknowledge,
  requestCloudEnrollmentFromSite,
  verifyCloudTokenFromSite,
  type SiteEnrollResponse,
} from "@/lib/local-activation-site-service";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
};

interface BootstrapRequestBody extends ProvisionRequestBody {
  deploymentMode?: string;
  verifyOnly?: boolean;
  cloudUrl?: string;
  cloudToken?: string;
  offlineToken?: string;
}

/**
 * First-run bootstrap: on a completely empty database, creates the business,
 * its first location, and the Owner account in one step, then signs the Owner
 * in so the wizard can continue.
 *
 * Issue #974: when `deploymentMode === "local"` (Full Offline desktop), fresh
 * setup fails closed unless `cloudUrl` and `cloudToken` (`OFL1-…`) are verified
 * live against the real Cloud API before any local business/user row is written.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json(
      { error: "already_initialized" },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  let body: BootstrapRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // Preflight Cloud token verification for the Full Offline onboarding step
  // (`Verify` button) without consuming the enrollment token or creating rows.
  if (body.verifyOnly === true) {
    const cloudUrl = typeof body.cloudUrl === "string" ? body.cloudUrl : "";
    const cloudToken =
      typeof body.cloudToken === "string"
        ? body.cloudToken
        : typeof body.offlineToken === "string"
          ? body.offlineToken
          : "";
    if (!cloudUrl.trim() || !cloudToken.trim()) {
      return NextResponse.json(
        { ok: false, error: "cloud_activation_required" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const verified = await verifyCloudTokenFromSite({
      cloudUrl,
      token: cloudToken,
    });
    if (!verified.ok) {
      return NextResponse.json(
        { ok: false, error: verified.error },
        { status: verified.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        cloudOrigin: verified.cloudOrigin,
        businessId: verified.businessBundle.businessId,
        businessName: verified.businessBundle.name,
        businessSlug: verified.businessBundle.slug,
        industry: verified.businessBundle.industry,
        locationName: verified.businessBundle.location.name,
        plan: verified.businessBundle.plan,
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  const deploymentMode = body.deploymentMode === "local" ? "local" : "connected";

  // Fail closed on Full Offline (`local`) setup before validating/burning anything
  // if Cloud origin or enrollment token is missing.
  const cloudUrl = typeof body.cloudUrl === "string" ? body.cloudUrl.trim() : "";
  const rawToken =
    typeof body.cloudToken === "string"
      ? body.cloudToken
      : typeof body.offlineToken === "string"
        ? body.offlineToken
        : "";
  const cloudToken = rawToken.trim();
  if (deploymentMode === "local" && (!cloudUrl || !cloudToken)) {
    return NextResponse.json(
      { error: "cloud_activation_required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // Validate owner & business input BEFORE staging enrollment on Cloud so a
  // local form validation typo never initiates an enrollment session.
  const validated = validateProvisionBody(body, { deploymentMode });
  if (!validated.input) {
    return NextResponse.json(
      { error: validated.error },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const input = validated.input;

  let localEnrollment: SiteEnrollResponse | null = null;
  if (deploymentMode === "local") {
    const enrollRes = await requestCloudEnrollmentFromSite({
      cloudUrl,
      token: cloudToken,
    });
    if (!enrollRes.ok) {
      return NextResponse.json(
        { error: enrollRes.error },
        { status: enrollRes.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    localEnrollment = enrollRes.enrolled;
  }

  const cloudBundle = localEnrollment?.businessBundle ?? null;
  const resolvedIndustry: Industry | undefined =
    cloudBundle && isIndustry(cloudBundle.industry)
      ? cloudBundle.industry
      : isIndustry(String(input.industry ?? ""))
        ? (input.industry as Industry)
        : undefined;

  let created;
  try {
    created = await provisionBusiness({
      ...input,
      businessName: cloudBundle ? cloudBundle.name : input.businessName,
      locationName: cloudBundle ? cloudBundle.location.name : input.locationName,
      address: cloudBundle ? (cloudBundle.location.address ?? input.address) : input.address,
      phone: cloudBundle ? (cloudBundle.location.phone ?? input.phone) : input.phone,
      industry: resolvedIndustry,
      deploymentMode,
      canonicalBusinessId: cloudBundle?.businessId,
      canonicalLocationId: cloudBundle?.location.id,
    });
    if (localEnrollment) {
      await commitLocalActivationRecordAndAcknowledge(
        created.businessId,
        localEnrollment,
        created.userId,
      );
    }
    await autoProvisionBusinessVirtualKey(created.businessId);
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      return NextResponse.json(
        { error: "email_password_mismatch" },
        { status: 409, headers: NO_STORE_HEADERS },
      );
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
      "first-run bootstrap could not open the Owner's session:",
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
  const res = NextResponse.json(
    {
      ok: true,
      signedIn: token !== null,
      mfa: {
        method: created.totpSecret ? ("totp" as const) : ("sms_otp" as const),
        totpSecret: created.totpSecret ?? null,
        totpUrl: created.totpUrl ?? null,
        totpQr: created.totpQr ?? null,
        recoveryCodes: created.recoveryCodes ?? [],
      },
    },
    { headers: NO_STORE_HEADERS },
  );
  if (token) res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
