import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_ORDER_STATUSES } from "@/lib/fashion-production";
import { createProductionOrder, listProductionOrders, productionReport } from "@/lib/fashion-production-service";
import { idempotencyKey, productionFailure, productionScope, quantity, stageCode, uuid } from "@/lib/fashion-production-http";

/**
 * GH #1567 6B — fashion production orders of the active branch.
 * `GET ?view=report` is the production summary (units, scrap, unit cost, WIP)
 * and the WIP subledger ↔ GL 1310 reconciliation — a view here rather than its
 * own route, because each route adds ~0.15 MiB to the desktop runtime.
 */
export const GET = withTenantScope(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (view !== null && view !== "report") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  if (view === "report") {
    try {
      return NextResponse.json({ report: await productionReport(scope.actor, scope.locationId) });
    } catch (error) {
      return productionFailure(error);
    }
  }
  const status = z.enum(PRODUCTION_ORDER_STATUSES).optional().safeParse(params.get("status") ?? undefined);
  if (!status.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ orders: await listProductionOrders(scope.actor, scope.locationId, status.data) });
  } catch (error) {
    return productionFailure(error);
  }
});

const createBody = z.object({
  bomId: uuid.nullable().optional(),
  outputItemId: uuid.nullable().optional(),
  lines: z.array(z.object({ materialItemId: uuid, quantityPerUnit: quantity }).strict()).max(60).nullable().optional(),
  plannedQuantity: quantity,
  reference: z.string().trim().min(1).max(60).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  stages: z.array(z.object({ code: stageCode, label: z.string().trim().min(1).max(60) }).strict()).min(1).max(12).nullable().optional(),
  idempotencyKey,
}).strict();

export const POST = withTenantScope(async (request: Request) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const body = createBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    const result = await createProductionOrder(scope.actor, scope.locationId, body.data);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return productionFailure(error);
  }
});
