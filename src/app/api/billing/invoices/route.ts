import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listInvoices, countInvoices } from "@/lib/subscription-service";

export const GET = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  const withLines = url.searchParams.get("withLines") === "1" || url.searchParams.get("withLines") === "true";

  if (status && !["draft", "open", "paid", "partially_paid", "overdue", "void"].includes(status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const [invoices, total] = await Promise.all([
    listInvoices({ businessId: session.businessId, status: status ?? undefined, limit, offset, withLines }),
    countInvoices({ businessId: session.businessId, status: status ?? undefined }),
  ]);

  return NextResponse.json({ invoices, total, limit, offset });
});
