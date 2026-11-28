import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PRODUCTION_COST_KINDS } from "@/lib/fashion-production";
import { applyProductionOrderAction, getProductionOrder } from "@/lib/fashion-production-service";
import { idempotencyKey, productionFailure, productionScope, quantity, stageCode, uuid } from "@/lib/fashion-production-http";

type Context = { params: Promise<{ id: string }> };

export const GET = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await getProductionOrder(scope.actor, scope.locationId, id.data));
  } catch (error) {
    return productionFailure(error);
  }
});

const materialLines = z.array(z.object({ materialItemId: uuid, quantity }).strict()).max(60);
const common = { expectedVersion: z.number().int().min(1), idempotencyKey };
const actionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("release"), ...common }).strict(),
  z.object({ action: z.literal("issue"), lines: materialLines.nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("return"), lines: materialLines.min(1), ...common }).strict(),
  z.object({ action: z.literal("progress"), stage: stageCode, completed: quantity.nullable().optional(),
    scrapped: quantity.nullable().optional(), note: z.string().trim().max(300).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("rework"), fromStage: stageCode, toStage: stageCode, quantity,
    note: z.string().trim().max(300).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("assign"), stage: stageCode, userId: uuid.nullable(), ...common }).strict(),
  z.object({ action: z.literal("cost"), kind: z.enum(PRODUCTION_COST_KINDS), amountRial: z.number().int().positive().max(1e13),
    stage: stageCode.nullable().optional(), note: z.string().trim().max(300).nullable().optional(),
    supplierName: z.string().trim().max(200).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("receive"), quantity, ...common }).strict(),
  z.object({ action: z.literal("complete"), ...common }).strict(),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3).max(300), returns: materialLines.nullable().optional(), ...common }).strict(),
  // GH #1567 6.3 — subcontracted stages (same route, same lock and idempotency).
  z.object({ action: z.literal("subcontract_create"), supplierId: uuid, stage: stageCode,
    ratePerUnitRial: z.number().int().min(0).max(1e13), reference: z.string().trim().max(60).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("subcontract_approve"), subcontractId: uuid, ...common }).strict(),
  z.object({ action: z.literal("subcontract_send"), subcontractId: uuid, quantity: quantity.nullable().optional(),
    materials: materialLines.nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("subcontract_receive"), subcontractId: uuid, accepted: quantity.nullable().optional(),
    rework: quantity.nullable().optional(), scrapped: quantity.nullable().optional(), shortage: quantity.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("subcontract_return_materials"), subcontractId: uuid, lines: materialLines.min(1), ...common }).strict(),
  z.object({ action: z.literal("subcontract_dispute"), subcontractId: uuid, note: z.string().trim().min(3).max(300), ...common }).strict(),
  z.object({ action: z.literal("subcontract_resolve"), subcontractId: uuid, note: z.string().trim().min(3).max(300),
    chargebackRial: z.number().int().min(0).max(1e13).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("subcontract_close"), subcontractId: uuid, declareRemainingLost: z.boolean().nullable().optional(),
    chargebackRial: z.number().int().min(0).max(1e13).nullable().optional(), ...common }).strict(),
  z.object({ action: z.literal("subcontract_cancel"), subcontractId: uuid, reason: z.string().trim().min(3).max(300), ...common }).strict(),
]);

/** GH #1567 6B — one step of a production order (idempotent, version-checked). */
export const POST = withTenantScope(async (request: Request, context: Context) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  const body = actionBody.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await applyProductionOrderAction(scope.actor, scope.locationId, id.data, body.data));
  } catch (error) {
    return productionFailure(error);
  }
});
