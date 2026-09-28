import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { OrdersList } from "@/app/dashboard/orders/orders-list";

export default async function OrdersPage({
  searchParams,
}: {
  /** `?order=<id>` opens that order's dialog straight away — see [id]/page.tsx. */
  searchParams: Promise<{ order?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "orders");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.ordersView)) redirect("/accounting");

  // Amending a *closed* order is its own permission, not part of the till's
  // edit rights — see permissions.ts. Reuse the same effective set that gated
  // the page so navigation, controls and server APIs cannot drift.
  const canAmendClosed = permissions.has(PERMISSIONS.ordersAmendClosed);

  const { order } = await searchParams;

  return (
    <OrdersList
      canEdit={permissions.has(PERMISSIONS.ordersCreate)}
      canTakePayment={permissions.has(PERMISSIONS.paymentsTake)}
      canAmendClosed={canAmendClosed}
      initialOrderId={order ?? null}
    />
  );
}
