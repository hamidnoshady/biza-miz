import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseLineClearanceRequest } from "@/lib/bank-reconciliation";
import { ReconciliationError, setLineCleared, setLinesCleared } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Clears or un-clears one — or a whole selection of — journal lines against
 * this in-progress reconciliation.
 *
 * The body is parsed by `parseLineClearanceRequest` instead of coerced here.
 * `Boolean(body.cleared)` used to read `"false"` as `true` and an omitted
 * `cleared` as `false`, so a client that forgot the flag un-cleared the line it
 * meant to tick; and a batch of mixed types was filtered down to just its
 * strings, answering `ok` for a write that covered fewer lines than the caller
 * asked for. A malformed payload is one 400 naming the reason, and a batch
 * that is refused is refused whole — never partly applied.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = parseLineClearanceRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    // The batch form is used only when the caller actually sent a list, so a
    // single-line PATCH keeps going through the exact path it always did.
    if (parsed.value.kind === "batch") {
      const { changed } = await setLinesCleared({
        businessId: session.businessId,
        reconciliationId: id,
        journalLineIds: parsed.value.journalLineIds,
        cleared: parsed.value.cleared,
      });
      return NextResponse.json({ ok: true, changed });
    }

    await setLineCleared({
      businessId: session.businessId,
      reconciliationId: id,
      journalLineId: parsed.value.journalLineId,
      cleared: parsed.value.cleared,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
