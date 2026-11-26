import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  listSignupAppPolicies,
  saveSignupAppPolicy,
} from "@/lib/complimentary-grant-service";
import {
  SignupPolicyError,
  isSignupPolicyMode,
  isSignupPolicyScope,
  resolveSignupAppPolicy,
  type SignupAppPolicy,
} from "@/lib/complimentary-grants";
import { APP_SERVICE_DEFINITIONS, isServiceKey, isServiceKind } from "@/lib/service-activation/catalog";
import { INDUSTRIES, type Industry } from "@/lib/industries";

/**
 * Superadmin → Billing → Services → Signup App Access (GitHub #1579).
 *
 * GET  — every policy revision, the four canonical billable apps with their
 *        global offer, and (optionally) a business-type preview resolved by
 *        the same pure precedence the signup catalog uses.
 * PUT  — append a new policy revision. Every write is a commercial decision,
 *        so it rides `billing.manage` and is audited with the exact figures.
 *
 * A request never activates, charges or grants anything by itself: it records
 * the offer that future eligible activations will be quoted under.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("billing.view");
  if (error) return error;

  const businessType = request.nextUrl.searchParams.get("businessType");
  const policies = await listSignupAppPolicies();
  const apps = APP_SERVICE_DEFINITIONS.map((app) => {
    const global = policies.find(
      (policy) =>
        policy.serviceKind === app.kind &&
        policy.serviceKey === app.key &&
        policy.scope === "global" &&
        policy.status === "active" &&
        policy.effectiveUntil == null,
    ) ?? null;
    const preview: SignupAppPolicy | null =
      businessType && INDUSTRIES.includes(businessType as Industry)
        ? resolveSignupAppPolicy(policies, {
            businessId: "",
            businessType,
            serviceKind: app.kind,
            serviceKey: app.key,
            at: new Date().toISOString(),
          })
        : null;
    return {
      kind: app.kind,
      key: app.key,
      label: app.label,
      globalOffer: global,
      previewOffer: preview,
    };
  });

  return NextResponse.json({
    apps,
    policies,
    businessTypes: INDUSTRIES,
    previewBusinessType: businessType ?? null,
  });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("billing.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!isServiceKind(kind) || !isServiceKey(kind, key)) {
    return NextResponse.json({ error: "unknown_service" }, { status: 404 });
  }
  const scope = body.scope;
  if (!isSignupPolicyScope(scope)) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }
  const mode = body.mode;
  if (!isSignupPolicyMode(mode)) {
    return NextResponse.json({ error: "unknown_mode" }, { status: 400 });
  }

  try {
    const saved = await saveSignupAppPolicy({
      serviceKind: kind,
      serviceKey: key,
      scope,
      businessType: typeof body.businessType === "string" ? body.businessType : null,
      businessId: typeof body.businessId === "string" ? body.businessId : null,
      mode,
      freeDays: body.freeDays == null ? null : Number(body.freeDays),
      waiveSetup: body.waiveSetup !== false,
      waiveRental: body.waiveRental !== false,
      effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : null,
      effectiveUntil: typeof body.effectiveUntil === "string" ? body.effectiveUntil : null,
      reason: typeof body.reason === "string" ? body.reason : "",
    });

    await platformAudit({
      adminId: session.padmin,
      action: "signup_app_policy.publish",
      entity: "signup_app_policy",
      entityId: saved.id,
      payload: {
        serviceKind: saved.serviceKind,
        serviceKey: saved.serviceKey,
        scope: saved.scope,
        businessType: saved.businessType,
        businessId: saved.businessId,
        mode: saved.mode,
        freeDays: saved.freeDays,
        waiveSetup: saved.waiveSetup,
        waiveRental: saved.waiveRental,
        version: saved.version,
        effectiveFrom: saved.effectiveFrom,
        reason: saved.reason,
      },
    });

    return NextResponse.json({ policy: saved });
  } catch (err) {
    if (err instanceof SignupPolicyError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
});
