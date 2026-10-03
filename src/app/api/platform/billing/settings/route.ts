import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  previewCommercialQuote,
  readCommercialSettings,
  saveCommercialSettings,
} from "@/lib/billing/runtime";
import { parseSafeIntInput } from "@/lib/platform-money";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  return NextResponse.json({ settings: await readCommercialSettings() });
});

export const PUT = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const dueDays = optionalInt(body.defaultDueDays, 0, 365);
  const graceDays = optionalInt(body.defaultGraceDays, 0, 365);
  const minTopUp = optionalInt(body.minimumTopUpRial, 0);
  const taxRateBps = optionalInt(body.taxRateBps, 0, 10_000);
  if (
    Number.isNaN(dueDays) ||
    Number.isNaN(graceDays) ||
    Number.isNaN(minTopUp) ||
    Number.isNaN(taxRateBps)
  ) {
    return NextResponse.json({ error: "invalid_number" }, { status: 400 });
  }

  await saveCommercialSettings({
    invoicePrefix: typeof body.invoicePrefix === "string" ? body.invoicePrefix : undefined,
    defaultDueDays: dueDays,
    defaultGraceDays: graceDays,
    rounding: body.rounding === "ceil" || body.rounding === "floor" ? body.rounding : undefined,
    minimumTopUpRial: minTopUp,
    overagePolicy:
      body.overagePolicy === "charge" || body.overagePolicy === "block"
        ? body.overagePolicy
        : undefined,
    prorationPolicy:
      body.prorationPolicy === "none" || body.prorationPolicy === "daily"
        ? body.prorationPolicy
        : undefined,
    defaultSpendAction:
      typeof body.defaultSpendAction === "string" ? body.defaultSpendAction : undefined,
    invoiceFooter: typeof body.invoiceFooter === "string" ? body.invoiceFooter : undefined,
    taxRateBps,
  });
  return NextResponse.json({ settings: await readCommercialSettings() });
});

export const POST = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const kindRaw = String(body.kind ?? "custom_top_up");
  const validKinds = new Set([
    "plan_subscription",
    "custom_top_up",
    "package_top_up",
    "addon_purchase",
    "meter_usage",
  ]);
  if (!validKinds.has(kindRaw)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }

  const amountParsed = optionalInt(body.amountRial, 0);
  const qtyParsed = optionalInt(body.quantity, 0);
  if (Number.isNaN(amountParsed) || Number.isNaN(qtyParsed)) {
    return NextResponse.json({ error: "invalid_number" }, { status: 400 });
  }

  const quote = await previewCommercialQuote({
    kind: kindRaw as
      | "plan_subscription"
      | "custom_top_up"
      | "package_top_up"
      | "addon_purchase"
      | "meter_usage",
    businessId: typeof body.businessId === "string" ? body.businessId : null,
    planKey: typeof body.planKey === "string" ? body.planKey : null,
    billingCycle: body.billingCycle === "yearly" ? "yearly" : "monthly",
    packageId: typeof body.packageId === "string" ? body.packageId : null,
    featureKey: typeof body.featureKey === "string" ? body.featureKey : null,
    meterKey: typeof body.meterKey === "string" ? body.meterKey : null,
    amountRial: amountParsed ?? 0,
    quantity: qtyParsed ?? 0,
    includeRecurringAddons: body.includeRecurringAddons !== false,
  });

  return NextResponse.json({ quote });
});

function optionalInt(value: unknown, min = 0, max?: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = parseSafeIntInput(value, { min, max });
  return parsed !== null ? parsed : NaN;
}
