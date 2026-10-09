import { NextRequest, NextResponse } from "next/server";
import { type Role, withTenantScope, requirePermission } from "@/lib/auth";
import { ALL_ROLES } from "@/lib/roles";
import { PERMISSIONS } from "@/lib/permissions";
import {
  appendDashboardWidget,
  getDashboardWidgets,
  saveDashboardWidgets,
  savedReportIdsInBusiness,
  type WidgetInput,
} from "@/lib/reports-service";

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

/**
 * The caller's dashboard widget layout: their personal one if they have one,
 * else their role's default. Every member who may read reports can view.
 *
 * The response carries the layout's `revision`. A client echoes it back on the
 * write it makes next, which is what stops two tabs — or a pin and a drag-save
 * — from silently discarding each other's change (issue #819). Each widget also
 * carries `applicable`, so the grid can explain a pin whose report the
 * business's trade no longer offers instead of drawing it as an empty chart.
 */
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
  /**
   * Append one widget instead of replacing the layout — the pin button's own
   * operation, done server-side (issue #819). See `appendDashboardWidget`.
   */
  append?: Omit<WidgetInput, "x" | "y">;
  /** The revision the client read; the write is refused when it no longer matches. */
  ifRevision?: string;
}

/** Shared validation: the ids arrive from the client, so they are facts to check, not to trust. */
function normalizeWidget(raw: WidgetInput): WidgetInput {
  return {
    savedReportId: String(raw.savedReportId ?? ""),
    chartType: raw.chartType,
    title: raw.title ?? null,
    x: Number(raw.x) || 0,
    y: Number(raw.y) || 0,
    w: Number(raw.w) || 4,
    h: Number(raw.h) || 3,
  };
}

function isWellFormed(widget: WidgetInput): boolean {
  return Boolean(widget.savedReportId) && ["line", "bar", "pie", "number"].includes(widget.chartType);
}

/**
 * Writes a widget layout — the caller's own, a role's default, or a single
 * appended pin.
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
 *
 * ## Concurrency
 *
 * A whole-layout replace is conditional on `ifRevision` — the value the client
 * read from `GET` — and is refused with 409 `layout_changed` when another write
 * landed in between, rather than deleting it. An append does not need one: it
 * is itself the atomic operation, so two simultaneous pins both survive.
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

  const target: { userId: string } | { role: Role } = roleDefault
    ? { role: body.role as Role }
    : { userId: session.sub };
  if (roleDefault && (!body.role || !ALL_ROLES.includes(body.role))) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  // --- append one pin -----------------------------------------------------
  if (body.append) {
    // Only the fields a pin actually decides: which report, how to draw it, and
    // its size. The row is the server's to compute from the layout it locks, so
    // a geometry field sent by the client is ignored rather than stored — the
    // browser cannot know the current layout, and both tabs would compute the
    // same row anyway.
    const widget: Omit<WidgetInput, "x" | "y"> = {
      savedReportId: String(body.append.savedReportId ?? ""),
      chartType: body.append.chartType,
      title: body.append.title ?? null,
      w: Number(body.append.w) || 4,
      h: Number(body.append.h) || 3,
    };
    if (!widget.savedReportId || !["line", "bar", "pie", "number"].includes(widget.chartType)) {
      return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    }
    const checked = await savedReportIdsInBusiness(session.businessId, [widget.savedReportId]);
    if (!checked.owned.has(widget.savedReportId)) {
      return NextResponse.json({ error: "unknown_saved_report" }, { status: 400 });
    }
    if (!checked.applicable.has(widget.savedReportId)) {
      return NextResponse.json({ error: "saved_report_not_applicable" }, { status: 400 });
    }
    const appended = await appendDashboardWidget(session.businessId, target, widget);
    if (!appended.ok) {
      return NextResponse.json({ error: appended.reason }, { status: 400 });
    }
    return NextResponse.json({ ok: true, revision: appended.revision, widget: appended.widget });
  }

  // --- replace the whole layout -------------------------------------------
  const widgets = (body.widgets ?? []).map(normalizeWidget);
  for (const widget of widgets) {
    if (!isWellFormed(widget)) {
      return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    }
  }

  const ids = widgets.map((w) => w.savedReportId);
  const checked = await savedReportIdsInBusiness(session.businessId, ids);
  if (ids.some((id) => !checked.owned.has(id))) {
    return NextResponse.json({ error: "unknown_saved_report" }, { status: 400 });
  }
  // Old tiles are deliberately retained and annotated on GET rather than
  // deleted when a business changes trade or a view is retired. A whole-layout
  // save may keep one that is already in this layout, so moving/removing a
  // neighbouring tile never destroys user state; it may not introduce a new
  // inapplicable pin.
  const inapplicableIds = [...new Set(ids.filter((id) => !checked.applicable.has(id)))];

  const written = await saveDashboardWidgets(session.businessId, target, widgets, {
    ifRevision: typeof body.ifRevision === "string" ? body.ifRevision : undefined,
    preserveInapplicableSavedReportIds: inapplicableIds,
  });
  if (!written.ok) {
    const status = written.reason === "layout_changed" ? 409 : 400;
    return NextResponse.json({ error: written.reason }, { status });
  }
  return NextResponse.json({ ok: true, revision: written.revision });
});
