import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  FixedAssetError,
  createFixedAsset,
  getFixedAssetReconciliation,
  listFixedAssetsPage,
  type FixedAssetAcquisitionSource,
  type FixedAssetListFilters,
} from "@/lib/fixed-assets-service";
import { isValidIsoDate } from "@/lib/jalali";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

export const dynamic = "force-dynamic";

/**
 * The register, server-side: filters, pagination and KPIs are the API's, so
 * «جستجو» no longer means «the browser downloads every asset first» and the
 * totals the cards show are the server's over the *whole* filtered register,
 * never one page's (issue #833).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const depreciationState = params.get("depreciationState");
  const sortBy = params.get("sortBy");
  const filters: FixedAssetListFilters = {
    search: params.get("search"),
    status: status === "disposed" || status === "active" || status === "archived" ? status : null,
    depreciationState:
      depreciationState === "none" ||
      depreciationState === "partial" ||
      depreciationState === "fully" ||
      depreciationState === "open"
        ? depreciationState
        : null,
    category: params.get("category"),
    locationId: params.get("locationId"),
    dateFrom: params.get("dateFrom"),
    dateTo: params.get("dateTo"),
    includeArchived: params.get("includeArchived") === "1",
    sortBy:
      sortBy === "date_asc" || sortBy === "cost_desc" || sortBy === "book_value_desc"
        ? (sortBy as FixedAssetListFilters["sortBy"])
        : null,
    limit: Number(params.get("limit")) || null,
    cursor: params.get("cursor"),
  };
  if (filters.dateFrom && !isValidIsoDate(filters.dateFrom)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (filters.dateTo && !isValidIsoDate(filters.dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  try {
    const [{ assets, hasMore, nextCursor, kpis }, reconciliation] = await Promise.all([
      listFixedAssetsPage(session.businessId, filters),
      getFixedAssetReconciliation(session.businessId),
    ]);
    return NextResponse.json({ fixedAssets: assets, hasMore, nextCursor, kpis, reconciliation });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) return NextResponse.json({ error: "ledger_account_missing" }, { status: 400 });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});

/**
 * Registers a fixed asset — no posting yet; depreciation is posted separately,
 * per period, via .../[id]/depreciate. Repeat-safe: send an `Idempotency-Key`
 * header and a retried submit returns the original asset instead of a twin.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  let body: {
    name?: string;
    acquisitionDate?: string;
    inServiceDate?: string | null;
    acquisitionSource?: string;
    acquisitionEntryId?: string | null;
    acquisitionAccountId?: string | null;
    acquisitionEntryDate?: string | null;
    cost?: number;
    salvageValue?: number;
    usefulLifeMonths?: number;
    code?: string | null;
    category?: string | null;
    serialNumber?: string | null;
    vendorPartyId?: string | null;
    custodianPartyId?: string | null;
    purchaseReference?: string | null;
    notes?: string | null;
    assetAccountId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  // «post_now»: the registration itself posts the purchase entry (Dr the
  // fixed-asset account / Cr a settlement account) — the normal acquisition
  // flow of issue #833. Everything else links an existing entry or records
  // opening/unlinked provenance.
  const wantsAcquisitionPosting =
    body.acquisitionSource === "post_now" && typeof body.acquisitionAccountId === "string" && body.acquisitionAccountId;

  try {
    const fixedAsset = await createFixedAsset({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      name: String(body.name ?? ""),
      acquisitionDate: String(body.acquisitionDate ?? ""),
      inServiceDate: typeof body.inServiceDate === "string" ? body.inServiceDate : null,
      acquisitionSource: (wantsAcquisitionPosting ? "unlinked" : body.acquisitionSource) as
        | FixedAssetAcquisitionSource
        | undefined,
      acquisitionEntryId: wantsAcquisitionPosting
        ? null
        : typeof body.acquisitionEntryId === "string"
          ? body.acquisitionEntryId
          : null,
      acquisition: wantsAcquisitionPosting
        ? {
            sourceAccountId: body.acquisitionAccountId!,
            entryDate: typeof body.acquisitionEntryDate === "string" ? body.acquisitionEntryDate : null,
          }
        : null,
      cost: Number(body.cost),
      salvageValue: Number(body.salvageValue ?? 0),
      usefulLifeMonths: Number(body.usefulLifeMonths),
      createdBy: session.sub,
      idempotencyKey: request.headers.get("Idempotency-Key"),
      code: typeof body.code === "string" ? body.code : null,
      category: typeof body.category === "string" ? body.category : null,
      serialNumber: typeof body.serialNumber === "string" ? body.serialNumber : null,
      vendorPartyId: typeof body.vendorPartyId === "string" && body.vendorPartyId ? body.vendorPartyId : null,
      custodianPartyId: typeof body.custodianPartyId === "string" && body.custodianPartyId ? body.custodianPartyId : null,
      purchaseReference: typeof body.purchaseReference === "string" ? body.purchaseReference : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      assetAccountId: typeof body.assetAccountId === "string" && body.assetAccountId ? body.assetAccountId : null,
    });
    return NextResponse.json({ fixedAsset }, { status: 201 });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) return NextResponse.json({ error: "ledger_account_missing" }, { status: 400 });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
