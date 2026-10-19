import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { OrdersHistory } from "@/app/dashboard/orders/orders-history";

export default async function OrdersHistoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "orders");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.ordersView)) redirect("/accounting");

  return (
    <OrdersHistory
      canEdit={permissions.has(PERMISSIONS.ordersCreate)}
      canTakePayment={permissions.has(PERMISSIONS.paymentsTake)}
      canAmendClosed={permissions.has(PERMISSIONS.ordersAmendClosed)}
      canRefund={permissions.has(PERMISSIONS.paymentsRefund)}
      canReviewShifts={permissions.has(PERMISSIONS.reportsView)}
    />
  );
}
