import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Business/location name + contact info for the printed receipt header — every
 * role that can check out an order needs it, not just managers (unlike
 * /api/setup/business) — plus the business's effective feature map, so a
 * selling screen can hide what the business is not entitled to (the POS stops
 * *offering* a delivery order the moment the `delivery` feature is off; the
 * domain layer still refuses one, whatever the client does).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.settingsManage,
    PERMISSIONS.ordersCreate,
    PERMISSIONS.ordersView,
    PERMISSIONS.inventoryView,
  );
  if (error) return error;

  const [{ rows }, location, profile, features] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [session.businessId]),
    resolveActiveLocation(session),
    getSetting<{ receiptFooter?: string }>(session.businessId, SETTING_KEYS.businessProfile),
    effectiveFeatures(session.businessId),
  ]);

  return NextResponse.json({
    name: rows[0]?.name ?? "",
    address: location?.address ?? null,
    phone: location?.phone ?? null,
    receiptFooter: profile?.receiptFooter ?? null,
    features,
  });
});
