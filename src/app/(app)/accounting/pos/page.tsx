import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry, requireModuleForPage } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { PosScreen } from "@/app/dashboard/pos/pos-screen";
import { RetailInvoiceScreen } from "@/app/dashboard/pos/retail-invoice-screen";

/**
 * The one public selling screen. Both hospitality and retail businesses enter
 * through `/accounting/pos`; the industry profile chooses the sale workflow,
 * not a second public route.
 */
export default async function PosPage({
  searchParams,
}: {
  /** `?table=<id>` starts a hospitality sale already seated at that table. */
  searchParams: Promise<{ table?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "pos");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.paymentsTake)) redirect("/dashboard");

  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  if (industryProfile(industry).salesModel === "retail_invoice") {
    // Voiding a completed invoice is the retail shape of the café's own
    // closed-order amendment — same permission, see retail-invoice-void-
    // service.ts and its API route's own doc comment.
    const canVoidInvoice = permissions.has(PERMISSIONS.ordersAmendClosed);
    return <RetailInvoiceScreen industry={industry} canVoidInvoice={canVoidInvoice} />;
  }
  const { table } = await searchParams;
  return <PosScreen initialTableId={table ?? null} />;
}
