import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { PERMISSIONS } from "@/lib/permissions";
import { parseRetailPricingPolicyInput } from "@/lib/retail-pricing-policy";
import {
  getDefaultTaxPercent,
  getRetailPricingPolicy,
  setRetailPricingPolicy,
} from "@/lib/retail-pricing-service";

/**
 * The business-wide policy behind the New Product «پیشنهاد قیمت فروش».
 *
 * Deliberately not under `/api/settings/pricing`: that prefix is the menu
 * cost-plus policy and `moduleForApiPath` gates it on the `menu` module, which
 * the product-workspace trades do not have.
 *
 * Read by anyone who can open the product form (it needs the numbers to show a
 * suggestion), written only by whoever manages settings — the same split as the
 * product attribute master.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const [policy, defaultTaxPercent] = await Promise.all([
    getRetailPricingPolicy(session.businessId),
    getDefaultTaxPercent(session.businessId),
  ]);
  return NextResponse.json({ policy, defaultTaxPercent });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const existing = await getRetailPricingPolicy(session.businessId);
  const parsed = parseRetailPricingPolicyInput(body, existing);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  await setRetailPricingPolicy(session.businessId, parsed.policy);
  return NextResponse.json({
    ok: true,
    policy: parsed.policy,
    defaultTaxPercent: await getDefaultTaxPercent(session.businessId),
  });
});
