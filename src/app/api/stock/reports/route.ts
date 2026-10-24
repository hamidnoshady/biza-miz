import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { deadStockCutoff, validateDeadStockDays } from "@/lib/retail-stock";
import { deadStockReportPage, lowStockReportPage } from "@/lib/retail-stock-service";

/**
 * Low-stock and dead-stock lists for a warehouse.
 * P1/P2 hardened: warehouse selector, strict period validation, paginated.
 *
 * Query params:
 *  locationId — UUID of warehouse; defaults to resolveActiveLocation(session)
 *  days       — dead-stock aging window; default 90, validated 1..3650
 *  page       — 1-based page number per report type (lowPage, deadPage)
 *  lowPage, deadPage — separate paging for each list; `page` is fallback for backward compat
 *  search     — filter by name/SKU
 *  includeInactive — include inactive items (default false)
 *  severity   — low|out|all filter for low-stock
 *  sortBy, sortDir — server sorting
 *  today     — ISO date override for testing (YYYY-MM-DD), else server today
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const url = new URL(request.url);
  const rawDays = url.searchParams.get("days");
  const rawLocationId = url.searchParams.get("locationId")?.trim() || url.searchParams.get("warehouseId")?.trim() || "";
  const search = (url.searchParams.get("search") ?? "").trim() || null;
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const severity = (url.searchParams.get("severity") as "all" | "out" | "low" | null) ?? "all";
  const sortBy = url.searchParams.get("sortBy") ?? "name";
  const sortDir = (url.searchParams.get("sortDir") as "asc" | "desc" | null) ?? "asc";
  const category = (url.searchParams.get("category") ?? "").trim() || null;
  const valuation = (url.searchParams.get("valuation") as "all" | "valued" | "missing" | null) ?? null;
  const tracking = (url.searchParams.get("tracking") ?? "").trim() || null;
  const rawPage = url.searchParams.get("page");
  const lowPageRaw = url.searchParams.get("lowPage") ?? rawPage ?? "1";
  const deadPageRaw = url.searchParams.get("deadPage") ?? rawPage ?? "1";
  const reportType = url.searchParams.get("type") as "low" | "dead" | "all" | null; // optional filter to return only one

  // Validate days strictly (P2)
  const daysValidation = validateDeadStockDays(rawDays);
  if (daysValidation.error) {
    return NextResponse.json(
      { error: daysValidation.error, message: "بازه زمانی نامعتبر است. مقدار باید عدد صحیح بین ۱ تا ۳۶۵۰ باشد." },
      { status: 400 },
    );
  }
  const days = daysValidation.days;

  // Validate today override
  const todayParam = url.searchParams.get("today");
  let todayIso = new Date().toISOString().slice(0, 10);
  if (todayParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(todayParam) || Number.isNaN(Date.parse(`${todayParam}T00:00:00Z`))) {
      return NextResponse.json({ error: "invalid_today", message: "تاریخ نامعتبر است." }, { status: 400 });
    }
    todayIso = todayParam;
  }

  // Resolve warehouse scope — enforce both tenant location scope and business_id ownership
  let locationId = rawLocationId || null;
  if (locationId) {
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request", message: "شناسه انبار نامعتبر است." }, { status: 400 });
    }
    // Verify ownership: business_id must match session, and location must exist (active or inactive).
    // This prevents cross-tenant probing and ensures warehouse scope is authoritative.
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1 AND business_id = $2`,
      [locationId, session.businessId],
    );
    if (!rows[0]) {
      return NextResponse.json({ error: "not_found", message: "انبار یافت نشد." }, { status: 404 });
    }
  } else {
    const location = await resolveActiveLocation(session);
    if (!location) {
      const cutoffEmpty = deadStockCutoff(todayIso, days);
      return NextResponse.json({
        low: { rows: [], total: 0, pagination: null, summary: {}, applied: { locationId: null, days, daysApplied: days, todayIso, cutoff: cutoffEmpty, category, valuation, tracking } },
        dead: { rows: [], total: 0, pagination: null, summary: {}, applied: { locationId: null, days, daysApplied: days, todayIso, cutoff: cutoffEmpty, category, valuation, tracking } },
        applied: { locationId: null, days, daysApplied: days, todayIso, cutoff: cutoffEmpty, search, includeInactive, severity, sortBy, sortDir, category, valuation, tracking },
      });
    }
    locationId = location.id;
  }

  const lowPage = Math.max(1, Math.floor(Number(lowPageRaw) || 1));
  const deadPage = Math.max(1, Math.floor(Number(deadPageRaw) || 1));
  const cutoff = deadStockCutoff(todayIso, days);

  // If only one report type requested, fetch just that (performance)
  if (reportType === "low") {
    const low = await lowStockReportPage(locationId, lowPage, { search, includeInactive, severity, sortBy, sortDir, category, valuation, tracking });
    return NextResponse.json({
      low: { ...low, rows: low.rows },
      applied: { locationId, days, daysApplied: days, todayIso, cutoff, search, includeInactive, severity, sortBy, sortDir, category, valuation, tracking },
    });
  }
  if (reportType === "dead") {
    const dead = await deadStockReportPage(locationId, days, todayIso, deadPage, { search, includeInactive, sortBy, sortDir, category, valuation, tracking });
    return NextResponse.json({
      dead: { ...dead, rows: dead.rows },
      applied: { locationId, days, daysApplied: days, todayIso, cutoff, search, includeInactive, sortBy, sortDir, category, valuation, tracking },
    });
  }

  const [low, dead] = await Promise.all([
    lowStockReportPage(locationId, lowPage, { search, includeInactive, severity, sortBy, sortDir, category, valuation, tracking }),
    deadStockReportPage(locationId, days, todayIso, deadPage, { search, includeInactive, sortBy, sortDir, category, valuation, tracking }),
  ]);

  return NextResponse.json({
    low: { ...low },
    dead: { ...dead },
    applied: { locationId, days, daysApplied: days, todayIso, cutoff, search, includeInactive, severity, sortBy, sortDir, category, valuation, tracking },
  });
});
