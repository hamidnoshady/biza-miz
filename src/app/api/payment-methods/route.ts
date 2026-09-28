import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listPaymentMethods } from "@/lib/payment-methods-service";

/**
 * The payment ways this business offers, in the order they should be shown.
 *
 * Read by every surface that takes money — the POS, the order dialog, the
 * closed-order amendment — which is why the guard is the checkout roles rather
 * than `settingsManage`: a cashier configures nothing here, but cannot ring up
 * a sale without knowing what the buttons are. Inactive ways are left out; a
 * retired way stays on the payments that used it, and is never offered again.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.paymentsTake,
    PERMISSIONS.ordersAmendClosed,
    PERMISSIONS.paymentsRefund,
  );
  if (error) return error;

  return NextResponse.json({ paymentMethods: await listPaymentMethods(session.businessId) });
});
