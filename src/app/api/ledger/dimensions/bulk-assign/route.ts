import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { assignDimensionsToDrafts } from "@/lib/draft-dimension-assignment";
import { ManualJournalError } from "@/lib/manual-journal-service";
import { AccountingDimensionError } from "@/lib/accounting-dimensions-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/**
 * POST /api/ledger/dimensions/bulk-assign — bulk attribution for unposted
 * drafts (issue #868). Body:
 *
 *   { draftIds: string[], dimensions: LineDimensions, mode: "fill_blank" | "overwrite", dryRun?: boolean }
 *
 * Gated on ledger.approve (accountant/owner): mass-editing draft attribution
 * is accounting authority, not drafting. `dryRun: true` previews without
 * writing. Answers 409 `draft_approval_race` when a targeted draft was
 * approved mid-flight, 400 for non-postable dimension values.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { draftIds, dimensions, mode, dryRun } = body as Record<string, unknown>;
  if (!Array.isArray(draftIds)) {
    return NextResponse.json({ error: "invalid_draft_ids" }, { status: 400 });
  }

  try {
    const result = await assignDimensionsToDrafts({
      businessId: session.businessId,
      actorId: session.sub,
      draftIds: draftIds as string[],
      dimensions,
      // The service rejects anything but the two modes (400), so an unknown
      // value is passed through as-is and refused there, once.
      mode: mode as "fill_blank" | "overwrite",
      dryRun: dryRun === true,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof ManualJournalError || err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
