import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isValidExpectedVersion } from "@/lib/price-list-conflicts";
import { savePriceEntries, type EntryUpdate } from "@/lib/price-lists-service";

/**
 * One «ذخیره قیمت‌ها» press: upserts filled cells, clears emptied ones.
 *
 * Each cell may carry the `expectedVersion` the editor loaded (audit F14). The
 * save applies every cell whose row is still at that version and answers
 * `200 { ok, touched, conflicts }`, where `conflicts` lists the cells it did
 * *not* write because someone changed them first — with their current value
 * and time. A cell without `expectedVersion` (an older client) is written
 * unconditionally, as before.
 */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { updates?: EntryUpdate[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const updates = body.updates ?? [];
  if (!Array.isArray(updates) || updates.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  for (const update of updates) {
    if (
      !update ||
      typeof update.priceListId !== "string" ||
      typeof update.itemId !== "string" ||
      // `price` is Rial and the column is a `bigint CHECK (price >= 0)`. A
      // negative, fractional or out-of-range number is a bad request, not a
      // row to silently drop: the matrix would report "saved" and show the old
      // value again on the next read.
      (update.price != null &&
        (!Number.isFinite(update.price) ||
          update.price < 0 ||
          update.price > Number.MAX_SAFE_INTEGER)) ||
      // A malformed version is refused rather than treated as "no version":
      // silently downgrading a checked write to an unconditional one is
      // exactly the overwrite the check exists to prevent.
      !isValidExpectedVersion(update.expectedVersion)
    ) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { touched, conflicts } = await savePriceEntries(updates, {
    locationId: location.id,
    businessId: session.businessId,
    userId: session.sub,
  });
  return NextResponse.json({ ok: true, touched, conflicts });
});
