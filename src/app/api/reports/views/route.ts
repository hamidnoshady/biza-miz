import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { reportViewsFor } from "@/lib/reports";

/**
 * The view whitelist (dimensions/metrics/filters), for the custom report
 * builder's source/metric/dimension pickers.
 *
 * Scoped to the caller's trade, like every other reporting surface: this list
 * used to be the whole of REPORT_VIEWS, so a jeweller's builder offered «چرخش
 * میزها» and «عملکرد پیک‌ها» as sources and produced a permanently empty report
 * from either. `reportViewsFor` applies the same requirement filter
 * `standardReportsFor` does, so the builder cannot offer a source the ready-made
 * list already hides.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  const views = reportViewsFor(industry).map(({ key, view }) => ({
    key,
    label: view.label,
    hasDateColumn: view.dateColumn !== null,
    dimensions: view.dimensions.map((d) => ({ key: d.key, label: d.label })),
    metrics: view.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      // Display-only: tells the client to render this metric through the
      // business's money formatter rather than as a bare number.
      money: m.money ?? false,
      aggregations: m.aggregations,
    })),
    filters: view.filters?.map((f) => ({ key: f.key, label: f.label, control: f.control })) ?? [],
  }));
  return NextResponse.json({ views });
});
