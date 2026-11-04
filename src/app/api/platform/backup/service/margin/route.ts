import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH,
  backupMarginReport,
  resolveMarginWindow,
} from "@/lib/tenant-backup-billing-jobs";

/**
 * Issue #903 §3 and §8 — **what the managed storage service earns against what it
 * costs**, for a window the operator picks.
 *
 * The epic asks Superadmin to monitor provider cost, plan inclusion and prices.
 * The arithmetic (`computeBackupMargin`) and the query (`backupMarginReport`) have
 * existed since the billing jobs landed; this is the route that finally exposes
 * them, so a margin figure is something the console can show rather than a
 * function someone has to call from a script.
 *
 * Three things this route deliberately does:
 *
 *  1. **States the assumption.** The provider cost per GB-month is not invented
 *     here and is not stored: the caller passes it, it defaults to
 *     `DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH` (zero — "not stated"), and the
 *     report echoes it back so the screen can label the number instead of
 *     presenting revenue as profit.
 *  2. **Refuses a window nobody asked for.** An inverted, unparseable or
 *     year-long range is a 400, not a quietly widened scan — `resolveMarginWindow`
 *     owns those rules and the tests pin them.
 *  3. **Reads only what the meter recorded.** Revenue is the `amount_rial` already
 *     settled into `usage_events`; a business whose meter has no price is
 *     reported `notPriced` per line rather than counted as pure margin.
 *
 * Capability `tenant_backup.policy`: this is a commercial figure — the same trust
 * that sets the storage policy and the supplier cost. A support desk holding
 * `tenant_backup.read` can see that a business is protected without seeing what
 * the platform pays for it, exactly as the managed-SMS wholesale numbers are
 * absent from the commercial catalogue.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("tenant_backup.policy");
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const window = resolveMarginWindow({
    from: params.get("from"),
    to: params.get("to"),
  });
  if (!window.ok) return NextResponse.json({ error: window.error }, { status: 400 });

  // Zero is a real answer ("no stated provider cost") and is the default, so the
  // only refusal here is a value that is not a non-negative whole number of Rial.
  const rawCost = params.get("providerCostRialPerGbMonth");
  let providerCostRialPerGbMonth = DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH;
  if (rawCost !== null && rawCost.trim() !== "") {
    const parsed = Number(rawCost.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) {
      return NextResponse.json({ error: "invalid_provider_cost" }, { status: 400 });
    }
    providerCostRialPerGbMonth = parsed;
  }

  const report = await backupMarginReport({
    from: window.from,
    to: window.to,
    providerCostRialPerGbMonth,
  });

  return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
});
