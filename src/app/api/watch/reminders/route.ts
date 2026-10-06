import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { serviceReminders } from "@/lib/watch-crm-service";
import { businessToday } from "@/lib/business-day-service";

/** The due-for-service list for the caller's branch — sold units whose next service (sale date + model interval) is due or overdue. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ reminders: [] });

  const leadDays = Number(request.nextUrl.searchParams.get("leadDays") ?? 30);
  // Issue #795 (item 21) — due/overdue is judged against the business's own
  // local day, not the UTC calendar day.
  const todayIso = await businessToday(session.businessId);
  const reminders = await serviceReminders(location.id, todayIso, Number.isFinite(leadDays) ? leadDays : 30);
  return NextResponse.json({ reminders });
});
