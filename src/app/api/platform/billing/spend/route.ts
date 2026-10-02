import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  evaluateBusinessSpend,
  getSpendPolicy,
  listSpendPolicies,
  saveSpendPolicy,
} from "@/lib/billing/runtime";
import { parseOptionalSafeIntInput, parseThresholdsInput } from "@/lib/platform-money";
import { query } from "@/lib/db";

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

export const PUT = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as {
    businessId?: string;
    monthlyBudgetRial?: unknown;
    actionAtLimit?: string;
    thresholds?: unknown;
  } | null;
  if (!body?.businessId || !body.actionAtLimit) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!VALID_ACTIONS.has(body.actionAtLimit as "warn_only")) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const parsedBudget = parseOptionalSafeIntInput(body.monthlyBudgetRial, { min: 0 });
  if (!parsedBudget.ok) {
    return NextResponse.json({ error: "invalid_budget" }, { status: 400 });
  }

  let thresholds: number[] | undefined;
  if (body.thresholds !== undefined && body.thresholds !== null && body.thresholds !== "") {
    const parsed = parseThresholdsInput(body.thresholds);
    if (parsed === null) {
      return NextResponse.json({ error: "invalid_thresholds" }, { status: 400 });
    }
    thresholds = parsed;
  }

  await saveSpendPolicy({
    businessId: body.businessId,
    monthlyBudgetRial: parsedBudget.value,
    actionAtLimit: body.actionAtLimit as
      | "continue"
      | "warn_only"
      | "block_noncritical"
      | "throttle_noncritical",
    thresholds,
  });
  const [policy, spend] = await Promise.all([
    getSpendPolicy(body.businessId),
    evaluateBusinessSpend(body.businessId),
  ]);
  return NextResponse.json({ policy, spend });
});
