import { NextRequest, NextResponse } from "next/server";
import { type Role, withTenantScope, requirePermission } from "@/lib/auth";
import { ALL_ROLES } from "@/lib/roles";
import { PERMISSIONS } from "@/lib/permissions";
import { getDashboardWidgets, saveDashboardWidgets, savedReportIdsInBusiness, type WidgetInput } from "@/lib/reports-service";

/**
 * The canonical role list (issue #819).
 *
 * This used to be a local `const ROLES = ["owner", "manager", "cashier",
 * "waiter", "kitchen"]` — a copy of the role vocabulary made before `admin`
 * and `accountant` existed, so those two could never have a role default
 * seeded or replaced through this route. `ALL_ROLES` from `roles.ts` is the one
 * definition of which roles exist; duplicating it here is how the reports
 * subsystem drifted from the role model in the first place.
 */

/** The caller's dashboard widget layout: their personal one if they have one, else their role's default. Every member who may read reports can view. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const result = await getDashboardWidgets(session.businessId, session.sub, session.role);
  return NextResponse.json(result);
});

interface WidgetBody {
  scope?: "personal" | "role";
  role?: Role;
  widgets?: WidgetInput[];
}

/**
 * Replaces a whole widget layout — the caller's own, or a role's default.
 *
 * ## Authorization (issue #819)
 *
 * The two layouts are two different acts and are now two different
 * capabilities:
 *
 *  - **personal** — the caller's own dashboard. `reports.view`: it is their own
 *    arrangement of reports they may already read.
 *  - **role default** — the layout *every member of that role* is seeded with
 *    when they have no personal one. It used to be writable by anyone holding
 *    `reports.view`, while the route's own documentation said role defaults
 *    were Owner/Manager only: any report viewer could POST
 *    `{scope:"role", role:"manager", widgets:[…]}` and replace a whole role's
 *    dashboard. It now requires `reports.dashboard_defaults.manage`.
 *
 * Every referenced report is verified to belong to this business before the
 * layout is stored: the ids arrive from the client, and an id from another
 * tenant (or a deleted one) would otherwise be written into `dashboard_widgets`
 * and surface as a widget the member cannot open.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  let body: WidgetBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const roleDefault = body.scope === "role";
  if (roleDefault) {
    const elevated = await requirePermission(PERMISSIONS.reportsDashboardDefaultsManage);
    if (elevated.error) return elevated.error;
  }

  const widgets = (body.widgets ?? []).map((w) => ({
    savedReportId: String(w.savedReportId ?? ""),
    chartType: w.chartType,
    title: w.title ?? null,
    x: Number(w.x) || 0,
    y: Number(w.y) || 0,
    w: Number(w.w) || 4,
    h: Number(w.h) || 3,
  }));
  for (const w of widgets) {
    if (!w.savedReportId || !["line", "bar", "pie", "number"].includes(w.chartType)) {
      return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    }
  }

  // One read for the whole layout, against this business's own saved reports.
  const known = await savedReportIdsInBusiness(
    session.businessId,
    widgets.map((w) => w.savedReportId),
  );
  if (widgets.some((w) => !known.has(w.savedReportId))) {
    return NextResponse.json({ error: "unknown_saved_report" }, { status: 400 });
  }

  if (roleDefault) {
    if (!body.role || !ALL_ROLES.includes(body.role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    await saveDashboardWidgets(session.businessId, { role: body.role }, widgets);
  } else {
    await saveDashboardWidgets(session.businessId, { userId: session.sub }, widgets);
  }
  return NextResponse.json({ ok: true });
});
