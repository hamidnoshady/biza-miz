import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  IntangibleAssetError,
  createIntangibleAsset,
  getIntangibleReconciliation,
  listIntangibleAssets,
  type IntangibleListFilters,
} from "@/lib/intangible-assets-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/jalali";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import type { UsefulLifeType } from "@/lib/intangible-assets";

export const dynamic = "force-dynamic";

/**
 * The intangible register (issue #1326 §4): a list filtered by class, life type,
 * status and branch, plus the register↔ledger reconciliation for the mapped
 * control accounts. Reads are `ledger.view`, like every other ledger read.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const lifeType = params.get("usefulLifeType");
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  if (dateFrom && !isValidIsoDate(dateFrom)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (dateTo && !isValidIsoDate(dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const filters: IntangibleListFilters = {
    search: params.get("search"),
    status: status === "active" || status === "disposed" ? status : null,
    assetClass: params.get("assetClass"),
    usefulLifeType: lifeType === "finite" || lifeType === "indefinite" ? (lifeType as UsefulLifeType) : null,
    locationId: params.get("locationId"),
    dateFrom,
    dateTo,
  };

  try {
    const [assets, reconciliation] = await Promise.all([
      listIntangibleAssets(session.businessId, filters),
      getIntangibleReconciliation(session.businessId),
    ]);
    return NextResponse.json({ intangibleAssets: assets, reconciliation });
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/**
 * Registers an intangible. Capitalization is explicit: the policy note and the
 * approving user are required, and no amount of "it arrived on an invoice"
 * makes a subscription an asset on its own (issue #1326 §1).
 *
 * `acquisitionAccountId` posts the purchase entry in the same transaction as
 * the registration (Dr the asset account / Cr that settlement account); without
 * it the register records the asset with unposted provenance. Repeat-safe via
 * the `Idempotency-Key` header.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAssetsManage);
  if (error) return error;

  let body: {
    name?: string;
    code?: string | null;
    description?: string | null;
    assetClass?: string;
    acquisitionDate?: string;
    availableForUseDate?: string | null;
    acquisitionSource?: string | null;
    cost?: number;
    directlyAttributableCost?: number | null;
    usefulLifeType?: string;
    usefulLifeMonths?: number | null;
    residualValue?: number | null;
    assetAccountId?: string | null;
    accumulatedAmortizationAccountId?: string | null;
    amortizationExpenseAccountId?: string | null;
    impairmentLossAccountId?: string | null;
    accumulatedImpairmentAccountId?: string | null;
    capitalizationPolicyNote?: string | null;
    evidenceReference?: string | null;
    custodianPartyId?: string | null;
    notes?: string | null;
    acquisitionAccountId?: string | null;
    acquisitionEntryDate?: string | null;
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

  try {
    const intangibleAsset = await createIntangibleAsset({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      name: String(body.name ?? ""),
      code: typeof body.code === "string" ? body.code : null,
      description: typeof body.description === "string" ? body.description : null,
      assetClass: String(body.assetClass ?? ""),
      acquisitionDate: String(body.acquisitionDate ?? ""),
      availableForUseDate: typeof body.availableForUseDate === "string" ? body.availableForUseDate : null,
      acquisitionSource: typeof body.acquisitionSource === "string" ? body.acquisitionSource : null,
      cost: Number(body.cost),
      directlyAttributableCost:
        body.directlyAttributableCost === undefined || body.directlyAttributableCost === null
          ? 0
          : Number(body.directlyAttributableCost),
      usefulLifeType: String(body.usefulLifeType ?? ""),
      usefulLifeMonths:
        body.usefulLifeMonths === undefined || body.usefulLifeMonths === null ? null : Number(body.usefulLifeMonths),
      residualValue:
        body.residualValue === undefined || body.residualValue === null ? 0 : Number(body.residualValue),
      assetAccountId: typeof body.assetAccountId === "string" && body.assetAccountId ? body.assetAccountId : null,
      accumulatedAmortizationAccountId:
        typeof body.accumulatedAmortizationAccountId === "string" && body.accumulatedAmortizationAccountId
          ? body.accumulatedAmortizationAccountId
          : null,
      amortizationExpenseAccountId:
        typeof body.amortizationExpenseAccountId === "string" && body.amortizationExpenseAccountId
          ? body.amortizationExpenseAccountId
          : null,
      impairmentLossAccountId:
        typeof body.impairmentLossAccountId === "string" && body.impairmentLossAccountId
          ? body.impairmentLossAccountId
          : null,
      accumulatedImpairmentAccountId:
        typeof body.accumulatedImpairmentAccountId === "string" && body.accumulatedImpairmentAccountId
          ? body.accumulatedImpairmentAccountId
          : null,
      capitalizationPolicyNote:
        typeof body.capitalizationPolicyNote === "string" ? body.capitalizationPolicyNote : null,
      capitalizedBy: session.sub,
      evidenceReference: typeof body.evidenceReference === "string" ? body.evidenceReference : null,
      custodianPartyId:
        typeof body.custodianPartyId === "string" && body.custodianPartyId ? body.custodianPartyId : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      acquisition:
        typeof body.acquisitionAccountId === "string" && body.acquisitionAccountId
          ? {
              sourceAccountId: body.acquisitionAccountId,
              entryDate: typeof body.acquisitionEntryDate === "string" ? body.acquisitionEntryDate : null,
            }
          : null,
      createdBy: session.sub,
      idempotencyKey: request.headers.get("Idempotency-Key"),
    });
    return NextResponse.json({ intangibleAsset }, { status: 201 });
  } catch (err) {
    if (err instanceof IntangibleAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing" }, { status: 400 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
