import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listLedger, countLedger } from "@/lib/wallet-service";

export const GET = withTenantScope(async (req: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.billingView);
  if (error) return error;

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const [entries, total] = await Promise.all([
    listLedger(session.businessId, limit, offset),
    countLedger(session.businessId),
  ]);

  return NextResponse.json({ entries, total, limit, offset });
});
