import { NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import { deletePlanFeature, listPlanFeatures, savePlanFeature } from "@/lib/billing-plans-service";
import { parseOptionalSafeIntInput, parseSafeIntInput } from "@/lib/platform-money";

/**
 * Per-feature pricing rows for one plan.
 *
 * Security note (the fix for the previously identified hole): this GET used to
 * rely on `withPlatformScope` alone, which establishes the tenant-scope bypass
 * for the handler but is NOT authentication — an unauthenticated caller could
 * read the whole global pricing catalogue. Every method here now runs a real
 * platform-admin guard first.
 */
export const GET = withPlatformScope(
  async (_req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const { error } = await requirePlatformAdmin();
    if (error) return error;
    const { key } = await ctx.params;
    return NextResponse.json({ features: await listPlanFeatures(key) });
  },
);

/**
 * Add / update a feature's price on a plan — the core of the plan builder:
 * pick a feature, choose included / monthly / per-use / add-on, set the cost,
 * and optionally a free-for-time (freeUntil) or free-for-N-uses (freeLimit)
 * promotion.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const guard = await requirePlatformCapability("plans.manage");
    if (guard.error) return guard.error;
    const { key: planKey } = await ctx.params;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const featureKey = String(body.featureKey ?? "").trim();
    const pricingModel = String(body.pricingModel ?? "");
    if (!featureKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    if (!["included", "monthly", "per_use", "addon"].includes(pricingModel)) {
      return NextResponse.json({ error: "bad_pricing_model" }, { status: 400 });
    }

    const priceRial =
      body.priceRial == null || body.priceRial === ""
        ? 0
        : parseSafeIntInput(body.priceRial, { min: 0 });
    if (priceRial === null) {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    const freeLimitParsed = parseOptionalSafeIntInput(body.freeLimit, { min: 0 });
    if (!freeLimitParsed.ok) {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }

    const existing = await listPlanFeatures(planKey);
    const before = existing.find((f) => f.featureKey === featureKey) ?? null;

    const feature = await savePlanFeature({
      planKey,
      featureKey,
      pricingModel: pricingModel as "included" | "monthly" | "per_use" | "addon",
      priceRial,
      freeUntil: typeof body.freeUntil === "string" && body.freeUntil ? body.freeUntil : null,
      freeLimit: freeLimitParsed.value,
      sortOrder: Math.floor(Number(body.sortOrder ?? 0)) || 0,
    });
    await platformAudit({
      adminId: guard.session.padmin,
      action: "plan.capability.changed",
      entity: "billing_plan_features",
      entityId: `${planKey}:${featureKey}`,
      payload: {
        planKey,
        featureKey,
        before: before
          ? { pricingModel: before.pricingModel, priceRial: before.priceRial, freeUntil: before.freeUntil, freeLimit: before.freeLimit }
          : null,
        after: {
          pricingModel: feature.pricingModel,
          priceRial: feature.priceRial,
          freeUntil: feature.freeUntil,
          freeLimit: feature.freeLimit,
        },
      },
    });
    return NextResponse.json({ feature });
  },
);

/** Remove a feature's pricing row from a plan (feature stays in the catalogue). */
export const DELETE = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
    const guard = await requirePlatformCapability("plans.manage");
    if (guard.error) return guard.error;
    const { key: planKey } = await ctx.params;
    const url = new URL(req.url);
    const featureKey = url.searchParams.get("featureKey");
    if (!featureKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    try {
      await deletePlanFeature(planKey, featureKey);
    } catch (err) {
      if (err instanceof Error && err.message === "plan_retired") {
        return NextResponse.json({ error: "plan_retired" }, { status: 409 });
      }
      throw err;
    }
    await platformAudit({
      adminId: guard.session.padmin,
      action: "plan.capability.changed",
      entity: "billing_plan_features",
      entityId: `${planKey}:${featureKey}`,
      payload: { planKey, featureKey, removed: true },
    });
    return NextResponse.json({ ok: true });
  },
);
