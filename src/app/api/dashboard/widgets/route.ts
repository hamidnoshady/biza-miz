import { NextRequest, NextResponse } from "next/server";
import { type Role, withTenantScope, requirePermission } from "@/lib/auth";
import { ALL_ROLES } from "@/lib/roles";
import { PERMISSIONS } from "@/lib/permissions";
import {
  appendDashboardWidget,
  getDashboardWidgets,
  getRoleDashboardWidgets,
  saveDashboardWidgets,
  savedReportIdsInBusiness,
  type DashboardLayoutName,
  type DashboardWidgetPrecondition,
  type WidgetInput,
} from "@/lib/reports-service";

interface WidgetBody {
  scope?: "personal" | "role";
  role?: Role;
  widgets?: unknown;
  append?: unknown;
  /** Whole-layout replacement requires both the visible source and write-target revisions. */
  precondition?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN;
}

function normalizeWidget(raw: unknown): WidgetInput | null {
  if (!isRecord(raw)) return null;
  const savedReportId = typeof raw.savedReportId === "string" ? raw.savedReportId.trim() : "";
  const chartType = raw.chartType;
  const title = raw.title === undefined || raw.title === null ? null : raw.title;
  if (typeof title !== "string" && title !== null) return null;
  if (typeof title === "string" && title.length > 200) return null;

  return {
    savedReportId,
    chartType: chartType as WidgetInput["chartType"],
    title,
    x: nonnegativeInteger(raw.x, 0),
    y: nonnegativeInteger(raw.y, 0),
    w: nonnegativeInteger(raw.w, 4),
    h: nonnegativeInteger(raw.h, 3),
  };
}

function isWellFormed(widget: WidgetInput): boolean {
  return Boolean(widget.savedReportId) &&
    ["line", "bar", "pie", "number"].includes(widget.chartType) &&
    widget.x >= 0 && widget.y >= 0 &&
    widget.w >= 2 && widget.w <= 12 && widget.x + widget.w <= 12 &&
    widget.h >= 2 && widget.h <= 20;
}

function parsePrecondition(
  raw: unknown,
  targetScope: DashboardLayoutName,
): { ok: true; value: DashboardWidgetPrecondition } | { ok: false; status: number; error: string } {
  if (!isRecord(raw) || !isRecord(raw.source) || !isRecord(raw.target)) {
    return { ok: false, status: 428, error: "precondition_required" };
  }
  if (
    !Object.hasOwn(raw.source, "revision") ||
    !Object.hasOwn(raw.target, "revision") ||
    !Object.hasOwn(raw.source, "scope") ||
    !Object.hasOwn(raw.target, "scope")
  ) {
    return { ok: false, status: 428, error: "precondition_required" };
  }

  const sourceScope = raw.source.scope;
  const targetScopeValue = raw.target.scope;
  const sourceRevision = raw.source.revision;
  const targetRevision = raw.target.revision;
  const validScope = (value: unknown): value is DashboardLayoutName =>
    value === "personal" || value === "role-default";

  if (
    !validScope(sourceScope) ||
    !validScope(targetScopeValue) ||
    typeof sourceRevision !== "string" || sourceRevision.length === 0 ||
    (targetRevision !== null && typeof targetRevision !== "string") ||
    targetScopeValue !== targetScope
  ) {
    return { ok: false, status: 400, error: "invalid_precondition" };
  }
  if (
    (targetScope === "role-default" &&
      (sourceScope !== "role-default" || targetRevision === null || sourceRevision !== targetRevision)) ||
    (targetScope === "personal" && sourceScope === "personal" &&
      (targetRevision === null || sourceRevision !== targetRevision)) ||
    (targetScope === "personal" && sourceScope === "role-default" && targetRevision !== null)
  ) {
    return { ok: false, status: 400, error: "invalid_precondition" };
  }

  return {
    ok: true,
    value: {
      source: { scope: sourceScope, revision: sourceRevision },
      target: { scope: targetScopeValue, revision: targetRevision as string | null },
    },
  };
}

/**
 * The caller's layout is personal when explicitly recorded; otherwise GET
 * serves their role default. A role-default read is available only to a member
 * who holds the dedicated management capability.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  const requestedScope = request.nextUrl.searchParams.get("scope");
  const requestedRole = request.nextUrl.searchParams.get("role");
  if (requestedScope === null || requestedScope === "personal") {
    if (requestedRole !== null) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
    return NextResponse.json(await getDashboardWidgets(session.businessId, session.sub, session.role));
  }
  if (requestedScope !== "role-default" || !requestedRole || !ALL_ROLES.includes(requestedRole as Role)) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  const elevated = await requirePermission(PERMISSIONS.reportsDashboardDefaultsManage);
  if (elevated.error) return elevated.error;
  return NextResponse.json(await getRoleDashboardWidgets(session.businessId, requestedRole as Role));
});

/**
 * Writes one atomic append or a revision-checked whole-layout replacement.
 * Personal first edits copy the current role default into a distinct personal
 * layout. Role defaults require the dedicated management permission.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(rawBody)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = rawBody as WidgetBody;
  if (body.scope !== undefined && body.scope !== "personal" && body.scope !== "role") {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  const roleDefault = body.scope === "role";
  if (roleDefault) {
    const elevated = await requirePermission(PERMISSIONS.reportsDashboardDefaultsManage);
    if (elevated.error) return elevated.error;
    if (!body.role || !ALL_ROLES.includes(body.role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
  } else {
    if (body.role !== undefined) return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    const personalWrite = await requirePermission(PERMISSIONS.reportsManage);
    if (personalWrite.error) return personalWrite.error;
  }

  const target = roleDefault
    ? { role: body.role as Role }
    : { userId: session.sub, role: session.role };
  const targetScope: DashboardLayoutName = roleDefault ? "role-default" : "personal";

  // Append is the pin-button operation. It has no caller revision because the
  // server serializes it and computes placement from the locked current layout.
  if (body.append !== undefined) {
    if (Object.hasOwn(body, "widgets")) {
      return NextResponse.json({ error: "ambiguous_layout_write" }, { status: 400 });
    }
    if (!isRecord(body.append)) return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    const raw = body.append;
    const savedReportId = typeof raw.savedReportId === "string" ? raw.savedReportId.trim() : "";
    const title = raw.title === undefined || raw.title === null ? null : raw.title;
    const w = nonnegativeInteger(raw.w, 4);
    const h = nonnegativeInteger(raw.h, 3);
    const chartType = raw.chartType as WidgetInput["chartType"];
    if (
      !savedReportId || typeof title !== "string" && title !== null ||
      typeof title === "string" && title.length > 200 ||
      !["line", "bar", "pie", "number"].includes(chartType) ||
      w < 2 || w > 12 || h < 2 || h > 20
    ) {
      return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    }

    const widget = { savedReportId, chartType, title, w, h };
    const checked = await savedReportIdsInBusiness(session.businessId, [savedReportId]);
    if (!checked.owned.has(savedReportId)) {
      return NextResponse.json({ error: "unknown_saved_report" }, { status: 400 });
    }
    if (!checked.applicable.has(savedReportId)) {
      return NextResponse.json({ error: "saved_report_not_applicable" }, { status: 400 });
    }

    const appended = await appendDashboardWidget(session.businessId, target, widget);
    if (!appended.ok) return NextResponse.json({ error: appended.reason }, { status: 400 });
    return NextResponse.json({ ok: true, revision: appended.revision, widget: appended.widget });
  }

  if (!Array.isArray(body.widgets)) {
    return NextResponse.json({ error: "invalid_widgets" }, { status: 400 });
  }
  const parsedPrecondition = parsePrecondition(body.precondition, targetScope);
  if (!parsedPrecondition.ok) {
    return NextResponse.json({ error: parsedPrecondition.error }, { status: parsedPrecondition.status });
  }

  const widgets = body.widgets.map(normalizeWidget);
  if (widgets.some((widget) => widget === null || !isWellFormed(widget))) {
    return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
  }
  const normalized = widgets as WidgetInput[];
  const ids = normalized.map((widget) => widget.savedReportId);
  const checked = await savedReportIdsInBusiness(session.businessId, ids);
  if (ids.some((id) => !checked.owned.has(id))) {
    return NextResponse.json({ error: "unknown_saved_report" }, { status: 400 });
  }
  // A stale tile may be kept only if it is present in the exact source/target
  // snapshot being replaced; the transaction verifies that condition again.
  const inapplicableIds = [...new Set(ids.filter((id) => !checked.applicable.has(id)))];
  const written = await saveDashboardWidgets(
    session.businessId,
    target,
    normalized,
    parsedPrecondition.value,
    { preserveInapplicableSavedReportIds: inapplicableIds },
  );
  if (!written.ok) {
    const status = written.reason === "layout_changed" ? 409 : 400;
    return NextResponse.json({ error: written.reason }, { status });
  }
  return NextResponse.json({ ok: true, revision: written.revision, precondition: written.precondition });
});
