import { NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  listBillingPlans,
  listFeatureCatalogue,
  listPlanFeatures,
  saveBillingPlan,
  activatePlan,
  retirePlan,
  getBillingPlan,
  type LimitSpec,
  type PlanLimitsSpec,
  type PlanStatus,
} from "@/lib/billing-plans-service";
import { parseOptionalSafeIntInput, parseSafeIntInput } from "@/lib/platform-money";

/**
 * The ONE plan builder's catalogue: every billing plan (identity, base
 * pricing, limits, lifecycle status), each one's per-feature pricing rows,
 * and the feature catalogue rows can be attached.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [plans, catalogue] = await Promise.all([listBillingPlans(false), listFeatureCatalogue()]);
  const featuresByPlan = await Promise.all(
    plans.map((p) => listPlanFeatures(p.key).then((rows) => [p.key, rows] as const)),
  );
  return NextResponse.json({
    plans,
    catalogue,
    featuresByPlan: Object.fromEntries(featuresByPlan),
  });
});

/** Parse one limit: an explicit limited/unlimited choice (never a guess). */
function parseLimit(value: unknown): LimitSpec | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object") return undefined;
  const spec = value as { unlimited?: unknown; value?: unknown };
  const unlimited = spec.unlimited === true;
  if (unlimited) {
    return { unlimited: true, value: null };
  }
  const parsed = parseSafeIntInput(spec.value, { min: 0 });
  if (parsed === null) {
    return { unlimited: false, value: -1 }; // sentinel → validation failure below
  }
  return { unlimited: false, value: parsed };
}

/** Create or update a billing plan, or transition its lifecycle. */
export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("plans.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Lifecycle transitions are their own action, with their own audit events.
  if (body.action === "activate" || body.action === "retire") {
    const key = String(body.key ?? "").trim();
    if (!key) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const before = await getBillingPlan(key);
    if (!before) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
    try {
      const plan = body.action === "activate" ? await activatePlan(key) : await retirePlan(key);
      await platformAudit({
        adminId: guard.session.padmin,
        action: body.action === "activate" ? "plan.activated" : "plan.retired",
        entity: "billing_plans",
        entityId: key,
        payload: { from: before.status, to: plan.status },
      });
      return NextResponse.json({ plan });
    } catch (err) {
      if (err instanceof Error && ["plan_retired", "plan_not_active"].includes(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  }

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const monthlyPriceParsed = parseOptionalSafeIntInput(body.monthlyPriceRial, { min: 0 });
  if (!monthlyPriceParsed.ok) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const monthlyPrice = monthlyPriceParsed.value;
  // Plan-included monthly AI credit (migration 0168). Missing/0/null all mean
  // "no included credit" so an update can also clear it.
  const monthlyAiCreditParsed = parseOptionalSafeIntInput(body.monthlyAiCreditRial, { min: 0 });
  if (!monthlyAiCreditParsed.ok) {
    return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
  }
  const monthlyAiCredit = monthlyAiCreditParsed.value;

  const status = body.status == null ? undefined : (String(body.status) as PlanStatus);
  if (status != null && !["draft", "active", "retired"].includes(status)) {
    return NextResponse.json({ error: "bad_status" }, { status: 400 });
  }

  const key = typeof body.key === "string" && body.key ? body.key : undefined;
  const before = key ? await getBillingPlan(key) : null;

  // When a limits object is sent, every limit must be an explicit choice —
  // a partial limits payload can never silently mean "unlimited".
  const limitsRaw = body.limits as Record<string, unknown> | undefined;
  let limits: PlanLimitsSpec | undefined;
  if (limitsRaw && typeof limitsRaw === "object") {
    const branches = parseLimit(limitsRaw.branches);
    const members = parseLimit(limitsRaw.members);
    const monthlyOrders = parseLimit(limitsRaw.monthlyOrders);
    const specs: (LimitSpec | undefined)[] = [branches, members, monthlyOrders];
    if (
      specs.some((spec) => spec == null) ||
      specs.some((spec) => spec != null && !spec.unlimited && (spec.value == null || spec.value < 0))
    ) {
      return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
    }
    limits = { branches: branches!, members: members!, monthlyOrders: monthlyOrders! };
  }

  try {
    const plan = await saveBillingPlan({
      key,
      name,
      description: typeof body.description === "string" ? body.description : null,
      monthlyPriceRial: monthlyPrice,
      monthlyAiCreditRial: monthlyAiCredit,
      status,
      sortOrder: Math.floor(Number(body.sortOrder ?? 0)) || 0,
      trialDays: body.trialDays == null ? undefined : Math.max(0, Math.floor(Number(body.trialDays))),
      graceDays: body.graceDays == null ? undefined : Math.max(0, Math.floor(Number(body.graceDays))),
      limits,
    });
    await platformAudit({
      adminId: guard.session.padmin,
      action: before ? "plan.updated" : "plan.created",
      entity: "billing_plans",
      entityId: plan.key,
      payload: {
        before: before
          ? {
              name: before.name,
              monthlyPriceRial: before.monthlyPriceRial,
              monthlyAiCreditRial: before.monthlyAiCreditRial,
              status: before.status,
              branchLimit: before.branchLimit,
              memberLimit: before.memberLimit,
              monthlyOrderLimit: before.monthlyOrderLimit,
            }
          : null,
        after: {
          name: plan.name,
          monthlyPriceRial: plan.monthlyPriceRial,
          monthlyAiCreditRial: plan.monthlyAiCreditRial,
          status: plan.status,
          branchLimit: plan.branchLimit,
          memberLimit: plan.memberLimit,
          monthlyOrderLimit: plan.monthlyOrderLimit,
        },
      },
    });
    return NextResponse.json({ plan });
  } catch (err) {
    if (err instanceof Error && ["limits_required", "invalid_limit", "bad_status"].includes(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});
