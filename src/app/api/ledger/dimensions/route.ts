import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isDimensionKind, type DimensionKind } from "@/lib/accounting-dimensions";
import {
  AccountingDimensionError,
  createDimensionValue,
  DIMENSION_VALUE_LIST_CAP,
  getDimensionValuesByIds,
  listDimensionSettings,
  listDimensionValues,
  searchDimensionValues,
  type DimensionValueInput,
} from "@/lib/accounting-dimensions-service";

/**
 * «ابعاد حسابداری»: the settings (which kinds are on) and the value records.
 *
 * Reading is `ledger.view` — the same door as the journal and the trial balance,
 * because a line's dimension is part of what a reader is entitled to see. Writing
 * is `accounts.edit`: a dimension is the structure of the chart's reporting, and
 * the people who may restructure the chart are the people who may restructure
 * this. Posting with a dimension needs nothing more than the posting itself.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const kindParam = params.get("kind");
  if (kindParam && !isDimensionKind(kindParam)) {
    return NextResponse.json({ error: "unknown_dimension_kind" }, { status: 400 });
  }
  const kind = kindParam ? (kindParam as DimensionKind) : undefined;
  const includeArchived = ["1", "true", "yes"].includes((params.get("includeArchived") ?? "").toLowerCase());
  const q = (params.get("q") ?? "").trim();
  const idsParam = params.get("ids");
  const postable = params.get("postable") !== "0" && params.get("postable") !== "false";
  const limitParam = Number(params.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? limitParam : 20;

  // Selected-ID resolution: a picker holding a value outside the initial capped
  // list must still be able to display the saved label. The response merges
  // these with search results so a single round trip is enough.
  const selectedIds = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const [settings, hits, selected] = await Promise.all([
    listDimensionSettings(session.businessId),
    q
      ? searchDimensionValues(session.businessId, { q, kind, postable, limit })
      : listDimensionValues(session.businessId, { kind, includeArchived }).then((r) => r.values),
    selectedIds.length > 0 ? getDimensionValuesByIds(session.businessId, selectedIds) : Promise.resolve([]),
  ]);

  // Merge selected + hits deduped by id, preserving server order for hits.
  const merged = new Map<string, (typeof selected)[number]>();
  for (const v of selected) merged.set(v.id, v);
  for (const v of hits) merged.set(v.id, v);
  const values = [...merged.values()];

  // Truncation flag: a search response is never truncated (it has its own
  // small LIMIT). The full-catalogue response reports truncation as before.
  const fullList = !q;
  return NextResponse.json({
    settings,
    values,
    truncated: fullList ? hits.length >= DIMENSION_VALUE_LIST_CAP : false,
    truncatedAt: fullList && hits.length >= DIMENSION_VALUE_LIST_CAP ? DIMENSION_VALUE_LIST_CAP : null,
    totalLoaded: values.length,
  });
});

/** Creates one value. Its kind must be one of the four; its code is unique per business and kind. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: Partial<DimensionValueInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const value = await createDimensionValue(session.businessId, session.sub, {
      kind: String(body.kind ?? ""),
      code: typeof body.code === "string" ? body.code : "",
      name: typeof body.name === "string" ? body.name : "",
      parentId: typeof body.parentId === "string" ? body.parentId : null,
      locationId: typeof body.locationId === "string" ? body.locationId : null,
      effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : null,
      effectiveTo: typeof body.effectiveTo === "string" ? body.effectiveTo : null,
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
    });
    return NextResponse.json({ value }, { status: 201 });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});
