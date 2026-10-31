import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPaymentConfig, getWallet, listLedger } from "@/lib/wallet-service";

/**
 * The business's wallet — balance, lifetime totals, and recent ledger entries.
 * Read by the small credit badge in the dashboard chrome (balance only) and
 * the billing page (full ledger). Any signed-in member may see the balance;
 * spending decisions are always made server-side regardless.
 */
export const GET = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const url = new URL(req.url);
  const withLedger = url.searchParams.get("ledger") !== "0";
  const [wallet, ledger, paymentConfig] = await Promise.all([
    getWallet(session.businessId),
    withLedger ? listLedger(session.businessId, 50) : Promise.resolve([]),
    // Issue #902 §0 — whether a top-up goes through a gateway or is recorded as
    // a manual transfer, in FIRST-PARTY words. The screen needs the distinction
    // to write an honest sentence; which gateway it is, is the platform's
    // business, so `gateway`/`merchantId`/`sandbox` stay out of this response.
    getPaymentConfig().then((config) => (config.gateway === "manual" ? "manual" : "online") as "manual" | "online"),
  ]);

  // P1: expose canManage for UI gating (billing.view can read, billing.manage can pay)
  const { requirePermission: requirePerm } = await import("@/lib/auth");
  const manageCheck = await requirePerm(PERMISSIONS.billingManage);
  const canManage = !manageCheck.error;

  return NextResponse.json({ wallet, ledger, canManage, paymentMode: paymentConfig });
});
