import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  amendClosedOrder,
  listOrderAmendments,
  OrderAmendmentError,
} from "@/lib/order-amendment-service";
import { validateAmendment, type AmendmentInput } from "@/lib/order-amendments";
import { PERMISSIONS } from "@/lib/permissions";
import { broadcast } from "@/lib/realtime";
import { resolveActiveLocation } from "@/lib/setup-state";
import { appendSyncOutboxEvent } from "@/lib/sync-outbox";

type Context = { params: Promise<{ id: string }> };

/**
 * Conditions someone can go and fix, rather than bugs. `fiscal_period_locked`
 * and `fiscal_period_soft_closed` come from migration 0024's trigger, which
 * fires on the *back-dated* entries this route posts — an amendment lands on
 * the day the order was sold, so a closed month refuses it here rather than
 * letting the correction silently move into the current one.
 */
const KNOWN_FAILURES: Record<string, number> = {
  order_not_found: 404,
  order_not_completed: 409,
  order_has_returns: 409,
  item_not_found: 404,
  duplicate_item: 400,
  invalid_item: 400,
  no_items: 400,
  menu_item_not_found: 404,
  modifier_not_found: 404,
  consumption_layer_settled: 409,
  consumption_reversal_inconsistent: 409,
  fiscal_period_locked: 409,
  fiscal_period_soft_closed: 409,
  negative_ingredient_requirement: 400,
};

function failureFor(err: unknown): NextResponse | null {
  if (err instanceof OrderAmendmentError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  const message = err instanceof Error ? err.message : "";
  const status = KNOWN_FAILURES[message];
  if (status) return NextResponse.json({ error: message }, { status });
  if (message.startsWith("inventory_exact_cutover_required")) {
    return NextResponse.json({ error: "inventory_exact_cutover_required" }, { status: 409 });
  }
  return null;
}

/** This order's correction history. */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersAmendClosed);
  if (error) return error;
  const { id } = await context.params;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM orders WHERE id=$1 AND location_id=$2", [
      id,
      location.id,
    ]);
    if (rowCount !== 1) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    return NextResponse.json({ amendments: await listOrderAmendments(client, id) });
  } finally {
    client.release();
  }
});

/**
 * Edit or remove an order that has already been paid for, with the accounting
 * that follows it: the posted revenue, VAT, tip, commission, A/R, stock
 * consumption and COGS are all reversed at their own recorded values, and — for
 * an edit — re-posted for the corrected bill. See order-amendment-service.ts.
 */
export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersAmendClosed);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: AmendmentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const validated = validateAmendment(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await amendClosedOrder(client, {
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      actorId: session.sub,
      input: validated.value,
    });
    // The paired peer replays the same correction through the same service,
    // with these line ids, so its books and its bill match this side's
    // (migration 0190). Same transaction: the correction and its delivery
    // commit together.
    await appendSyncOutboxEvent(client, {
      locationId: location.id,
      clientEventId: `order-amendment:${result.id}`,
      eventType: "order.amendment.posted",
      payload: { orderId: id, input: body as unknown as Record<string, unknown>, newItemIds: result.addedItemIds },
      actorUserId: session.sub,
      actorRole: session.role,
    });
    await client.query("COMMIT");
    broadcast(location.id, { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const failure = failureFor(err);
    if (failure) return failure;
    throw err;
  } finally {
    client.release();
  }
});
