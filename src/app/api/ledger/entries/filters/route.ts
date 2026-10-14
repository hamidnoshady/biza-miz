import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listJournalFilterOptions } from "@/lib/journal-service";

/**
 * The values «دفتر روزنامه» can actually be filtered by in *this* business.
 *
 * Replaces the old `/api/ledger/entries/source-types`, which answered one
 * quarter of the question. The journal's pickers — منبع، شعبه، ثبت‌کننده،
 * پروژه — are all built the same way and for the same reason: from the book
 * itself, not from the full label table, the whole branch list or the whole
 * org chart. A café has never posted a `gold_sale`, and offering fifty codes
 * of which six can match is a worse filter than six that all can. The same
 * holds for a branch that has never been posted to and a member who has never
 * posted.
 *
 * Source codes come back raw; the screen labels them through
 * `ledgerSourceLabel`, which is the one place a code becomes Persian.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json(await listJournalFilterOptions(session.businessId));
});
