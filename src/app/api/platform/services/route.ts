import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { listServicePrices } from "@/lib/service-activation/pricing-service";
import { listRetentionPolicies } from "@/lib/service-activation/retention-service";
import {
  APP_SERVICE_DEFINITIONS,
  WORKSPACE_SERVICE_DEFINITIONS,
  setupFeeRial,
} from "@/lib/service-activation/catalog";

/**
 * The super-admin «راه‌اندازی سرویس و نرخ ساعتی» catalogue (issue #1041 §E.1):
 * every service identity with its current published tariff, its setup fee and
 * its retention policy, plus every price version for the history column.
 *
 * Read rides `billing.view` like the rest of the billing console; publishing a
 * price and editing retention are separate, separately-audited writes.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.view");
  if (error) return error;

  const [prices, policies] = await Promise.all([listServicePrices(), listRetentionPolicies()]);
  const current = prices.filter((row) => row.current);
  const definitions = [...APP_SERVICE_DEFINITIONS, ...WORKSPACE_SERVICE_DEFINITIONS];
  const agentKeys = [
    ...new Set(current.filter((row) => row.serviceKind === "agent").map((row) => row.serviceKey)),
  ];

  const services = [
    ...definitions.map((definition) => ({
      kind: definition.kind,
      key: definition.key,
      label: definition.label,
      description: definition.description,
    })),
    ...agentKeys.map((key) => ({
      kind: "agent" as const,
      key,
      label: key,
      description: "عامل/روتین پس‌زمینهٔ منتشرشده.",
    })),
  ].map((service) => {
    const tariff =
      current.find((row) => row.serviceKind === service.kind && row.serviceKey === service.key) ??
      null;
    return {
      ...service,
      tariff,
      setupRial: tariff && tariff.published ? setupFeeRial(tariff) : 0,
      retention:
        policies.find((row) => row.kind === service.kind && row.key === service.key) ?? null,
      // Published is the eligibility gate: false means "fail closed".
      eligible: Boolean(tariff?.published),
    };
  });

  return NextResponse.json({
    services,
    priceVersions: prices,
  });
});
