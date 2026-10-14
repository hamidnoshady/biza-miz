import { NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  evaluateBusinessSpend,
  getSpendPolicy,
  listSpendPolicies,
  saveSpendPolicy,
} from "@/lib/billing/runtime";
import { parseOptionalSafeIntInput, parseThresholdsInput } from "@/lib/platform-money";
import { query, withoutTenantScopeTransaction } from "@/lib/db";

const VALID_ACTIONS = new Set([
  "continue",
  "warn_only",
  "block_noncritical",
  "throttle_noncritical",
] as const);

export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const businessId = new URL(req.url).searchParams.get("businessId");
  if (!businessId) {
    const [policies, bizRes] = await Promise.all([
      listSpendPolicies(),
      query<{ id: string; name: string; plan: string }>(
        `SELECT id, name, plan FROM businesses ORDER BY name LIMIT 200`,
      ),
    ]);
    return NextResponse.json({
      policies,
      businesses: bizRes.rows.map((b) => ({ id: b.id, name: b.name, planKey: b.plan })),
    });
  }
  const [policy, spend] = await Promise.all([
    getSpendPolicy(businessId),
    evaluateBusinessSpend(businessId),
  ]);
  return NextResponse.json({ policy, spend });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Save a business's spend policy (audit F16). The policy row and its durable
 * `platform_audit_log` entry — actor, business, before and after — commit in
 * ONE transaction: a failed audit write rolls the policy change back, and a
 * change never lands without its record. Invalid input is refused before any
 * write.
 */
export const PUT = withPlatformScope(async (req: Request) => {
  const { session, error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as {
    businessId?: unknown;
    monthlyBudgetRial?: unknown;
    actionAtLimit?: unknown;
    thresholds?: unknown;
  } | null;
  if (!body || typeof body.businessId !== "string" || !body.actionAtLimit) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!UUID_RE.test(body.businessId.trim())) {
    return NextResponse.json({ error: "invalid_business", field: "businessId" }, { status: 400 });
  }
  const businessId = body.businessId.trim();
  if (typeof body.actionAtLimit !== "string" || !VALID_ACTIONS.has(body.actionAtLimit as "warn_only")) {
    return NextResponse.json({ error: "invalid_action", field: "actionAtLimit" }, { status: 400 });
  }
  const actionAtLimit = body.actionAtLimit as
    | "continue"
    | "warn_only"
    | "block_noncritical"
    | "throttle_noncritical";

  const parsedBudget = parseOptionalSafeIntInput(body.monthlyBudgetRial, { min: 0 });
  if (!parsedBudget.ok) {
    return NextResponse.json({ error: "invalid_budget", field: "monthlyBudgetRial" }, { status: 400 });
  }

  let thresholds: number[] | undefined;
  if (body.thresholds !== undefined && body.thresholds !== null && body.thresholds !== "") {
    const parsed = parseThresholdsInput(body.thresholds);
    if (parsed === null) {
      return NextResponse.json({ error: "invalid_thresholds", field: "thresholds" }, { status: 400 });
    }
    thresholds = parsed;
  }

  return withoutTenantScopeTransaction("platform", async () => {
    const before = await getSpendPolicy(businessId);
    await saveSpendPolicy({
      businessId,
      monthlyBudgetRial: parsedBudget.value,
      actionAtLimit,
      thresholds,
    });
    const after = await getSpendPolicy(businessId);

    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "billing.spend_policy.updated",
      entity: "business_spend_policy",
      entityId: businessId,
      payload: {
        before: spendPolicySnapshot(before),
        after: spendPolicySnapshot(after),
      },
    });

    const [policy, spend] = await Promise.all([
      getSpendPolicy(businessId),
      evaluateBusinessSpend(businessId),
    ]);
    return NextResponse.json({ policy, spend });
  });
});

function spendPolicySnapshot(policy: Awaited<ReturnType<typeof getSpendPolicy>>) {
  if (!policy) return null;
  return {
    monthlyBudgetRial: policy.monthlyBudgetRial,
    actionAtLimit: policy.actionAtLimit,
    thresholds: policy.thresholds,
  };
}
