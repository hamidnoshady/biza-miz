import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { mergeCustomers, PartyMergeRefusedError, previewMerge } from "@/lib/crm-service";

/**
 * Merge two customer records (Phase 36).
 *
 * Two endpoints on purpose:
 *
 * - `GET ?winner=&loser=` returns the **preview** — what will move, what tags
 *   the merged record ends up with, and what consent it ends up with. The
 *   consent line is the one people get wrong: it is the *intersection*, so a
 *   merge can never grant a permission neither record held.
 * - `POST` performs it, in one transaction.
 *
 * Owner/manager only, and absent from `ACTION_CATALOG`, so no assistant,
 * autopilot job or MCP client can reach it. The merge is irreversible — the
 * loser is archived rather than deleted, but the references have moved — and
 * "irreversible" plus "automatic" is a combination this codebase does not ship.
 *
 * It writes no accounting document: orders keep their totals, dates and
 * periods, only their `customer_id` changes, so the trial balance is identical
 * before and after. The integration test asserts exactly that.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const winnerId = search.get("winner");
  const loserId = search.get("loser");
  if (!winnerId || !loserId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (winnerId === loserId) return NextResponse.json({ error: "merge_same_customer" }, { status: 400 });

  const preview = await previewMerge(session.businessId, winnerId, loserId);
  if (!preview) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  return NextResponse.json({ preview });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmMerge);
  if (error) return error;

  let body: { winnerId?: string; loserId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { winnerId, loserId } = body;
  if (!winnerId || !loserId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (winnerId === loserId) return NextResponse.json({ error: "merge_same_customer" }, { status: 400 });

  let result: Awaited<ReturnType<typeof mergeCustomers>>;
  try {
    result = await mergeCustomers(session.businessId, winnerId, loserId, {
      mergedBy: session.fullName,
      // The stable membership id alongside the display name: a name can be
      // corrected later, and an audit row for an irreversible operation has to
      // stay resolvable to the person who performed it.
      mergedByUserId: session.sub,
    });
  } catch (err) {
    // GH #1567 C2: e.g. live tailoring measurements on the losing record — refused, nothing moved.
    if (err instanceof PartyMergeRefusedError) {
      return NextResponse.json({ error: err.code, blockers: err.blockers }, { status: 409 });
    }
    throw err;
  }
  if (!result) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  return NextResponse.json({ merge: result });
});
