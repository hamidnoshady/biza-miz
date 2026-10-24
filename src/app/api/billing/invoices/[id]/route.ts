import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getInvoice } from "@/lib/subscription-service";

export const GET = withTenantScope(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;
  const { id } = await ctx.params;
  const invoice = await getInvoice(id, true);
  if (!invoice) return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  if (invoice.businessId !== session.businessId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ invoice });
});
