import { NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getRetailPricingOverview, publishRetailPriceVersion } from "@/lib/kavenegar/retail-pricing-service";

/**
 * Issue #902 §4 — retail pricing for the managed messaging service, edited from
 * the ONE commercial catalogue (`/platform/billing?tab=usage`).
 *
 *   GET  — the policy in force, the version history and the fleet's month-to-date
 *          volume. Readable by any admin: it is a price, not a secret.
 *   POST — publish a new version. `billing.manage` only (support never holds
 *          it), audited to `platform_audit_log` with before/after.
 *
 * The wholesale half of the service is deliberately absent here: supplier
 * tariffs, cost and margin are internal and live on the platform SMS console.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const overview = await getRetailPricingOverview();
  return NextResponse.json(overview);
});

export const POST = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const before = await getRetailPricingOverview();
  const result = await publishRetailPriceVersion({ body, createdBy: guard.session.padmin });
  if (!result.ok) {
    const status = result.error === "effective_from_before_current" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  await platformAudit({
    adminId: guard.session.padmin,
    action: "messaging_retail_pricing.published",
    entity: "kavenegar_retail_price_versions",
    entityId: result.version.id,
    payload: {
      version: result.version.version,
      before: before.current,
      after: result.version,
    },
  });

  return NextResponse.json({ version: result.version });
});
