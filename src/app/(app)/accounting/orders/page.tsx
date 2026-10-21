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
      canRefund={permissions.has(PERMISSIONS.paymentsRefund)}
      // Issue #913 item 3 — the same keys PATCH /api/orders/[id] and the item
      // route enforce server-side; the dialog must not offer an act the API
      // will refuse (nor hide one it would allow).
      canDiscount={permissions.has(PERMISSIONS.ordersDiscount)}
      canVoid={permissions.has(PERMISSIONS.ordersVoid)}
      canVoidItem={permissions.has(PERMISSIONS.ordersVoidItem)}
      initialOrderId={order ?? null}
    />
  );
}
