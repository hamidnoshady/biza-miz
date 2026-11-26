/**
 * GH #1567 Phase 6B — fashion production orders on the `items` stock model.
 *
 * Every mutation runs in one tenant transaction that:
 *   1. returns the first result if the idempotency key was already used
 *      (a retried request never moves stock twice);
 *   2. locks the order row and checks `expectedVersion` (a stale screen gets
 *      409 instead of overwriting someone else's progress);
 *   3. applies the pure rules from fashion-production.ts;
 *   4. moves stock only through F1's moving-WAC primitives
 *      (`relieveFungibleStock` / `restoreFungibleStock`) and posts the exact
 *      value they report through the posting engine — subledger and GL agree
 *      by construction;
 *   5. appends one row to the append-only action log (the audit trail).
 *
 * Rules and accounts: see fashion-production.ts and
 * fashion-production-posting-rules.ts.
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "./db";
import {
  actionAllowed,
  applyProgress,
  applyRework,
  materialCoversReceipt,
  materialReturnValue,
  normaliseStages,
  outstandingUnits,
  positiveQuantity,
  ProductionRuleError,
  receiptValue,
  receivableQuantity,
  requiredQuantity,
  shortages,
  totalScrapped,
  unitCost,
  wipBalance,
  type MaterialNeed,
  type ProductionCostKind,
  type ProductionOrderStatus,
  type StageDefinition,
  type StageState,
} from "./fashion-production";
import { FASHION_PRODUCTION_EVENTS } from "./fashion-production-posting-rules";
import { rialText } from "./inventory-exact";
import { ItemStockValuationError, lockFungibleStock, relieveFungibleStock, restoreFungibleStock } from "./item-stock-valuation";
import { emitDomainEvent } from "./posting-engine";
import { WELL_KNOWN_CODES } from "./coa-template";

export const PRODUCTION_SOURCE_TYPE = "item_production_order";

export interface ProductionActor {
  businessId: string;
  userId: string | null;
  /** Holds `ledger.approve` — required to write residual WIP off on cancel/close. */
  canWriteOff: boolean;
}

export class FashionProductionError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly detail?: Record<string, unknown>) {
    super(code);
    this.name = "FashionProductionError";
  }
}

function fail(code: string, status = 409, detail?: Record<string, unknown>): never {
  throw new FashionProductionError(code, status, detail);
}

function asProductionError(error: unknown): never {
  if (error instanceof ProductionRuleError) fail(error.code, 409, error.detail);
  if (error instanceof ItemStockValuationError) fail(`stock_${error.code}`, 409);
  throw error;
}

// ── items ─────────────────────────────────────────────────────────────────

interface ItemRow { id: string; name: string; unit: string | null; kind: string; tracking: string }

/** Items of THIS branch that can hold fungible stock (no variant parents, no serial/batch goods). */
async function requireStockItems(client: PoolClient, locationId: string, ids: string[]): Promise<Map<string, ItemRow>> {
  const unique = [...new Set(ids)];
  const { rows } = await client.query<ItemRow>(
    `SELECT id, name, unit, kind, tracking FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2`,
    [unique, locationId],
  );
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const item = map.get(id);
    if (!item) fail("item_not_found", 404, { itemId: id });
    if (item.kind === "variant_parent") fail("item_is_variant_parent", 409, { itemId: id });
    if (item.tracking !== "none") fail("item_tracking_not_supported", 409, { itemId: id });
  }
  return map;
}

// ── BOMs ──────────────────────────────────────────────────────────────────

export interface BomLineInput { materialItemId: string; quantityPerUnit: string }
export interface BomInput {
  name: string;
  outputItemId: string;
  conversionCostPerUnitRial: number;
  lines: BomLineInput[];
}

function validateBom(input: BomInput): void {
  if (input.lines.length === 0) fail("bom_has_no_lines", 400);
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (line.materialItemId === input.outputItemId) fail("bom_material_is_output", 400);
    if (seen.has(line.materialItemId)) fail("bom_duplicate_material", 400);
    seen.add(line.materialItemId);
    try { positiveQuantity(line.quantityPerUnit); } catch (e) { asProductionError(e); }
  }
}

export async function listBoms(actor: ProductionActor, locationId: string) {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<{
      id: string; name: string; output_item_id: string; output_name: string; conversion_cost_per_unit_rial: string;
      is_active: boolean; lines: { materialItemId: string; name: string; unit: string | null; quantityPerUnit: string }[];
    }>(
      `SELECT b.id, b.name, b.output_item_id, oi.name AS output_name, b.conversion_cost_per_unit_rial::text, b.is_active,
              COALESCE(jsonb_agg(jsonb_build_object('materialItemId', l.material_item_id, 'name', mi.name, 'unit', mi.unit,
                'quantityPerUnit', trim_scale(l.quantity_per_unit)::text) ORDER BY mi.name) FILTER (WHERE l.bom_id IS NOT NULL), '[]') AS lines
         FROM item_production_boms b
         JOIN items oi ON oi.id = b.output_item_id
         LEFT JOIN item_production_bom_lines l ON l.bom_id = b.id
         LEFT JOIN items mi ON mi.id = l.material_item_id
        WHERE b.business_id = $1 AND b.location_id = $2
        GROUP BY b.id, oi.name
        ORDER BY b.is_active DESC, b.name`,
      [actor.businessId, locationId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, outputItemId: r.output_item_id, outputName: r.output_name,
      conversionCostPerUnitRial: Number(r.conversion_cost_per_unit_rial), isActive: r.is_active, lines: r.lines,
    }));
  });
}

/** Creates a BOM, or replaces an existing one's header and lines (orders keep their own snapshot). */
export async function saveBom(actor: ProductionActor, locationId: string, input: BomInput, bomId?: string) {
  validateBom(input);
  return withTenantTransaction(actor.businessId, async (client) => {
    await requireStockItems(client, locationId, [input.outputItemId, ...input.lines.map((l) => l.materialItemId)]);
    let id = bomId;
    try {
      if (id) {
        const updated = await client.query(
          `UPDATE item_production_boms SET name = $3, output_item_id = $4, conversion_cost_per_unit_rial = $5, is_active = true, updated_at = now()
            WHERE id = $1 AND business_id = $2 AND location_id = $6`,
          [id, actor.businessId, input.name, input.outputItemId, input.conversionCostPerUnitRial, locationId],
        );
        if (updated.rowCount !== 1) fail("bom_not_found", 404);
        await client.query(`DELETE FROM item_production_bom_lines WHERE bom_id = $1`, [id]);
      } else {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO item_production_boms (business_id, location_id, output_item_id, name, conversion_cost_per_unit_rial, created_by)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [actor.businessId, locationId, input.outputItemId, input.name, input.conversionCostPerUnitRial, actor.userId],
        );
        id = rows[0].id;
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") fail("bom_name_taken");
      throw error;
    }
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO item_production_bom_lines (bom_id, business_id, material_item_id, quantity_per_unit) VALUES ($1, $2, $3, $4)`,
        [id, actor.businessId, line.materialItemId, positiveQuantity(line.quantityPerUnit)],
      );
    }
    return { id };
  });
}

export async function deactivateBom(actor: ProductionActor, locationId: string, bomId: string) {
  return withTenantTransaction(actor.businessId, async (client) => {
    const r = await client.query(
      `UPDATE item_production_boms SET is_active = false, updated_at = now() WHERE id = $1 AND business_id = $2 AND location_id = $3`,
      [bomId, actor.businessId, locationId],
    );
    if (r.rowCount !== 1) fail("bom_not_found", 404);
    return { deactivated: true };
  });
}

// ── orders: reads ─────────────────────────────────────────────────────────

interface OrderRow {
  id: string; location_id: string; bom_id: string | null; output_item_id: string; reference: string;
  planned_quantity: string; received_quantity: string; scrapped_quantity: string; status: ProductionOrderStatus;
  due_date: string | null; material_cost_rial: string; conversion_cost_rial: string; received_value_rial: string;
  returned_value_rial: string; written_off_rial: string; version: number; created_at: string; closed_at: string | null;
}

const ORDER_COLUMNS = `id, location_id, bom_id, output_item_id, reference, trim_scale(planned_quantity)::text AS planned_quantity,
  trim_scale(received_quantity)::text AS received_quantity, trim_scale(scrapped_quantity)::text AS scrapped_quantity, status,
  due_date::text, material_cost_rial::text, conversion_cost_rial::text, received_value_rial::text, returned_value_rial::text,
  written_off_rial::text, version, created_at::text, closed_at::text`;

function wipOf(o: OrderRow) {
  return {
    materialCost: BigInt(o.material_cost_rial), conversionCost: BigInt(o.conversion_cost_rial),
    receivedValue: BigInt(o.received_value_rial), returnedValue: BigInt(o.returned_value_rial), writtenOff: BigInt(o.written_off_rial),
  };
}

function orderSummary(o: OrderRow, outputName: string, stages: StageState[]) {
  const wip = wipOf(o);
  return {
    id: o.id, reference: o.reference, status: o.status, outputItemId: o.output_item_id, outputName,
    bomId: o.bom_id, plannedQuantity: o.planned_quantity, receivedQuantity: o.received_quantity,
    scrappedQuantity: o.scrapped_quantity, dueDate: o.due_date, version: o.version, createdAt: o.created_at, closedAt: o.closed_at,
    receivableQuantity: receivableQuantity(stages, o.received_quantity),
    outstandingQuantity: outstandingUnits(o.planned_quantity, o.scrapped_quantity, o.received_quantity),
    costs: {
      materialRial: Number(wip.materialCost), conversionRial: Number(wip.conversionCost), receivedRial: Number(wip.receivedValue),
      returnedRial: Number(wip.returnedValue), writtenOffRial: Number(wip.writtenOff), wipRial: Number(wipBalance(wip)),
      unitCostRial: unitCost(wip.receivedValue, o.received_quantity),
    },
  };
}

async function loadStages(client: PoolClient, orderId: string) {
  const { rows } = await client.query<{
    seq: number; code: string; label: string; assignee_user_id: string | null; assignee_name: string | null;
    completed: string; scrapped: string; rework: string;
  }>(
    `SELECT s.seq, s.code, s.label, s.assignee_user_id, u.full_name AS assignee_name,
            trim_scale(s.completed_quantity)::text AS completed, trim_scale(s.scrapped_quantity)::text AS scrapped,
            trim_scale(s.rework_quantity)::text AS rework
       FROM item_production_order_stages s LEFT JOIN users u ON u.id = s.assignee_user_id
      WHERE s.order_id = $1 ORDER BY s.seq`,
    [orderId],
  );
  return rows;
}

async function loadMaterials(client: PoolClient, orderId: string) {
  const { rows } = await client.query<{
    material_item_id: string; name: string; unit: string | null; quantity_per_unit: string; required: string; issued: string;
    issued_value: string; returned: string; returned_value: string; on_hand: string;
  }>(
    `SELECT m.material_item_id, i.name, i.unit, trim_scale(m.quantity_per_unit)::text AS quantity_per_unit,
            trim_scale(m.required_quantity)::text AS required, trim_scale(m.issued_quantity)::text AS issued,
            m.issued_value_rial::text AS issued_value, trim_scale(m.returned_quantity)::text AS returned,
            m.returned_value_rial::text AS returned_value, trim_scale(COALESCE(st.quantity, 0))::text AS on_hand
       FROM item_production_order_materials m
       JOIN items i ON i.id = m.material_item_id
       LEFT JOIN item_stock st ON st.item_id = m.material_item_id
      WHERE m.order_id = $1 ORDER BY i.name`,
    [orderId],
  );
  return rows;
}

async function readOrder(client: PoolClient, businessId: string, locationId: string, orderId: string, lock: boolean): Promise<OrderRow> {
  const { rows } = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM item_production_orders WHERE id = $1 AND business_id = $2 AND location_id = $3 ${lock ? "FOR UPDATE" : ""}`,
    [orderId, businessId, locationId],
  );
  if (!rows[0]) fail("order_not_found", 404);
  return rows[0];
}

async function orderDetail(client: PoolClient, businessId: string, locationId: string, orderId: string) {
  const order = await readOrder(client, businessId, locationId, orderId, false);
  const [stages, materials, output, actions] = await Promise.all([
    loadStages(client, orderId),
    loadMaterials(client, orderId),
    client.query<{ name: string; unit: string | null }>(`SELECT name, unit FROM items WHERE id = $1`, [order.output_item_id]),
    client.query<{ id: string; action: string; actor_name: string | null; detail: Record<string, unknown>; amount_rial: string | null; at: string }>(
      `SELECT a.id, a.action, u.full_name AS actor_name, a.detail, a.amount_rial::text, a.at::text
         FROM item_production_order_actions a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.order_id = $1 ORDER BY a.at, a.id`,
      [orderId],
    ),
  ]);
  const stageStates = stages.map((s) => ({ seq: s.seq, code: s.code, completed: s.completed, scrapped: s.scrapped }));
  return {
    order: { ...orderSummary(order, output.rows[0]?.name ?? "—", stageStates), outputUnit: output.rows[0]?.unit ?? null },
    stages: stages.map((s) => ({
      seq: s.seq, code: s.code, label: s.label, assigneeUserId: s.assignee_user_id, assigneeName: s.assignee_name,
      completedQuantity: s.completed, scrappedQuantity: s.scrapped, reworkQuantity: s.rework,
    })),
    materials: materials.map((m) => ({
      materialItemId: m.material_item_id, name: m.name, unit: m.unit, quantityPerUnit: m.quantity_per_unit,
      requiredQuantity: m.required, issuedQuantity: m.issued, issuedValueRial: Number(m.issued_value),
      returnedQuantity: m.returned, returnedValueRial: Number(m.returned_value), onHand: m.on_hand,
    })),
    actions: actions.rows.map((a) => ({
      id: a.id, action: a.action, actorName: a.actor_name, detail: a.detail,
      amountRial: a.amount_rial == null ? null : Number(a.amount_rial), at: a.at,
    })),
  };
}

export type ProductionOrderDetail = Awaited<ReturnType<typeof orderDetail>>;

export async function getProductionOrder(actor: ProductionActor, locationId: string, orderId: string) {
  return withTenantTransaction(actor.businessId, (client) => orderDetail(client, actor.businessId, locationId, orderId));
}

export async function listProductionOrders(actor: ProductionActor, locationId: string, status?: ProductionOrderStatus) {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows } = await client.query<OrderRow & { output_name: string; stages: StageState[] & { label: string }[] }>(
      `SELECT ${ORDER_COLUMNS},
              (SELECT name FROM items WHERE id = o.output_item_id) AS output_name,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('seq', s.seq, 'code', s.code, 'label', s.label,
                        'completed', trim_scale(s.completed_quantity)::text, 'scrapped', trim_scale(s.scrapped_quantity)::text) ORDER BY s.seq)
                  FROM item_production_order_stages s WHERE s.order_id = o.id), '[]') AS stages
         FROM item_production_orders o
        WHERE o.business_id = $1 AND o.location_id = $2 AND ($3::text IS NULL OR o.status = $3)
        ORDER BY (o.status IN ('completed', 'cancelled')), o.due_date NULLS LAST, o.created_at DESC
        LIMIT 300`,
      [actor.businessId, locationId, status ?? null],
    );
    return rows.map((r) => ({
      ...orderSummary(r, r.output_name, r.stages),
      stages: (r.stages as unknown as { seq: number; code: string; label: string; completed: string; scrapped: string }[]),
    }));
  });
}

// ── orders: create ────────────────────────────────────────────────────────

export interface CreateOrderInput {
  bomId?: string | null;
  /** Without a BOM: the output and its material lines directly. */
  outputItemId?: string | null;
  lines?: BomLineInput[] | null;
  plannedQuantity: string;
  reference?: string | null;
  dueDate?: string | null;
  stages?: StageDefinition[] | null;
  idempotencyKey: string;
}

async function priorAction(client: PoolClient, businessId: string, key: string) {
  const { rows } = await client.query<{ order_id: string; action: string }>(
    `SELECT order_id, action FROM item_production_order_actions WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, key],
  );
  return rows[0] ?? null;
}

async function logAction(
  client: PoolClient, actor: ProductionActor, orderId: string, actionId: string, action: string, key: string,
  detail: Record<string, unknown>, amount: bigint | null,
) {
  await client.query(
    `INSERT INTO item_production_order_actions (id, business_id, order_id, action, idempotency_key, actor_user_id, detail, amount_rial)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [actionId, actor.businessId, orderId, action, key, actor.userId, JSON.stringify(detail), amount == null ? null : amount.toString()],
  );
}

export async function createProductionOrder(actor: ProductionActor, locationId: string, input: CreateOrderInput) {
  let planned: string;
  let stages: StageDefinition[];
  try {
    planned = positiveQuantity(input.plannedQuantity);
    stages = normaliseStages(input.stages);
  } catch (e) {
    asProductionError(e);
  }
  return withTenantTransaction(actor.businessId, async (client) => {
    const prior = await priorAction(client, actor.businessId, input.idempotencyKey);
    if (prior) {
      if (prior.action !== "create") fail("idempotency_key_reused");
      return { ...(await orderDetail(client, actor.businessId, locationId, prior.order_id)), duplicate: true };
    }
    let outputItemId: string;
    let lines: BomLineInput[];
    let bomId: string | null = null;
    if (input.bomId) {
      const { rows } = await client.query<{ output_item_id: string; is_active: boolean }>(
        `SELECT output_item_id, is_active FROM item_production_boms WHERE id = $1 AND business_id = $2 AND location_id = $3`,
        [input.bomId, actor.businessId, locationId],
      );
      if (!rows[0]) fail("bom_not_found", 404);
      if (!rows[0].is_active) fail("bom_inactive");
      bomId = input.bomId;
      outputItemId = rows[0].output_item_id;
      const bomLines = await client.query<{ material_item_id: string; quantity_per_unit: string }>(
        `SELECT material_item_id, trim_scale(quantity_per_unit)::text AS quantity_per_unit FROM item_production_bom_lines WHERE bom_id = $1`,
        [bomId],
      );
      lines = bomLines.rows.map((l) => ({ materialItemId: l.material_item_id, quantityPerUnit: l.quantity_per_unit }));
    } else {
      if (!input.outputItemId || !input.lines) fail("bom_or_lines_required", 400);
      outputItemId = input.outputItemId;
      lines = input.lines;
    }
    validateBom({ name: "-", outputItemId, conversionCostPerUnitRial: 0, lines });
    await requireStockItems(client, locationId, [outputItemId, ...lines.map((l) => l.materialItemId)]);

    const orderId = randomUUID();
    const reference = input.reference?.trim() || `PRD-${Date.now().toString(36).toUpperCase()}`;
    try {
      await client.query(
        `INSERT INTO item_production_orders (id, business_id, location_id, bom_id, output_item_id, reference, planned_quantity, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orderId, actor.businessId, locationId, bomId, outputItemId, reference, planned, input.dueDate ?? null, actor.userId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") fail("reference_taken");
      throw error;
    }
    for (const line of lines) {
      const perUnit = positiveQuantity(line.quantityPerUnit);
      await client.query(
        `INSERT INTO item_production_order_materials (order_id, business_id, material_item_id, quantity_per_unit, required_quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, actor.businessId, line.materialItemId, perUnit, requiredQuantity(perUnit, planned)],
      );
    }
    for (const [index, stage] of stages.entries()) {
      await client.query(
        `INSERT INTO item_production_order_stages (order_id, business_id, seq, code, label) VALUES ($1, $2, $3, $4, $5)`,
        [orderId, actor.businessId, index + 1, stage.code, stage.label],
      );
    }
    await logAction(client, actor, orderId, randomUUID(), "create", input.idempotencyKey,
      { reference, plannedQuantity: planned, bomId, stages: stages.map((s) => s.code) }, null);
    return { ...(await orderDetail(client, actor.businessId, locationId, orderId)), duplicate: false };
  });
}

// ── orders: actions ───────────────────────────────────────────────────────

export type ProductionOrderAction =
  | { action: "release" }
  | { action: "issue"; lines?: { materialItemId: string; quantity: string }[] | null }
  | { action: "return"; lines: { materialItemId: string; quantity: string }[] }
  | { action: "progress"; stage: string; completed?: string | null; scrapped?: string | null; note?: string | null }
  | { action: "rework"; fromStage: string; toStage: string; quantity: string; note?: string | null }
  | { action: "assign"; stage: string; userId: string | null }
  | { action: "cost"; kind: ProductionCostKind; amountRial: number; stage?: string | null; note?: string | null; supplierName?: string | null }
  | { action: "receive"; quantity: string }
  | { action: "complete" }
  | { action: "cancel"; reason: string; returns?: { materialItemId: string; quantity: string }[] | null };

async function reservedElsewhere(client: PoolClient, businessId: string, orderId: string, itemIds: string[]): Promise<Map<string, string>> {
  const { rows } = await client.query<{ material_item_id: string; reserved: string }>(
    `SELECT m.material_item_id, trim_scale(sum(GREATEST(m.required_quantity - m.issued_quantity, 0)))::text AS reserved
       FROM item_production_order_materials m JOIN item_production_orders o ON o.id = m.order_id
      WHERE o.business_id = $1 AND o.status IN ('released', 'in_progress') AND o.id <> $2 AND m.material_item_id = ANY($3::uuid[])
      GROUP BY m.material_item_id`,
    [businessId, orderId, itemIds],
  );
  return new Map(rows.map((r) => [r.material_item_id, r.reserved]));
}

/** Locks the materials' stock rows in a fixed order, so two orders releasing/issuing the same fabric serialise. */
async function lockMaterialStock(client: PoolClient, itemIds: string[]): Promise<Map<string, string>> {
  const onHand = new Map<string, string>();
  for (const id of [...itemIds].sort()) {
    const state = await lockFungibleStock(client, id);
    onHand.set(id, state?.quantity ?? "0");
  }
  return onHand;
}

async function post(client: PoolClient, actor: ProductionActor, locationId: string, orderId: string, actionId: string,
  eventType: string, amount: bigint) {
  if (amount <= 0n) return;
  await emitDomainEvent(client, {
    businessId: actor.businessId,
    locationId,
    eventType,
    payload: { amount: rialText(amount.toString()), productionOrderId: orderId },
    sourceType: PRODUCTION_SOURCE_TYPE,
    sourceId: orderId,
    createdBy: actor.userId,
    postingSourceId: actionId,
  });
}

async function writeStages(client: PoolClient, orderId: string, before: StageState[], after: StageState[], reworkAt?: string, reworkQty?: string) {
  for (const [i, stage] of after.entries()) {
    const changed = stage.completed !== before[i].completed || stage.scrapped !== before[i].scrapped || stage.code === reworkAt;
    if (!changed) continue;
    await client.query(
      `UPDATE item_production_order_stages
          SET completed_quantity = $3, scrapped_quantity = $4,
              rework_quantity = rework_quantity + $5
        WHERE order_id = $1 AND seq = $2`,
      [orderId, stage.seq, stage.completed, stage.scrapped, stage.code === reworkAt ? reworkQty ?? "0" : "0"],
    );
  }
}

export async function applyProductionOrderAction(
  actor: ProductionActor,
  locationId: string,
  orderId: string,
  input: ProductionOrderAction & { expectedVersion: number; idempotencyKey: string },
) {
  return withTenantTransaction(actor.businessId, async (client) => {
    const prior = await priorAction(client, actor.businessId, input.idempotencyKey);
    if (prior) {
      if (prior.order_id !== orderId || prior.action !== input.action) fail("idempotency_key_reused");
      return { ...(await orderDetail(client, actor.businessId, locationId, orderId)), duplicate: true };
    }
    const order = await readOrder(client, actor.businessId, locationId, orderId, true);
    if (order.version !== input.expectedVersion) fail("version_conflict", 409, { version: order.version });
    if (!actionAllowed(order.status, input.action)) fail("action_not_allowed", 409, { status: order.status, action: input.action });

    const actionId = randomUUID();
    const stagesRaw = await loadStages(client, orderId);
    const stages: StageState[] = stagesRaw.map((s) => ({ seq: s.seq, code: s.code, completed: s.completed, scrapped: s.scrapped }));
    const materials = await loadMaterials(client, orderId);
    let nextStatus: ProductionOrderStatus = order.status;
    let amount: bigint | null = null;
    let detail: Record<string, unknown> = {};
    const wip = wipOf(order);

    try {
      switch (input.action) {
        case "release": {
          const ids = materials.map((m) => m.material_item_id);
          const onHand = await lockMaterialStock(client, ids);
          const elsewhere = await reservedElsewhere(client, actor.businessId, orderId, ids);
          const needs: MaterialNeed[] = materials.map((m) => ({
            materialItemId: m.material_item_id, name: m.name,
            need: Decimal.max(new Decimal(m.required).minus(m.issued), 0).toFixed(),
            onHand: onHand.get(m.material_item_id) ?? "0", reservedElsewhere: elsewhere.get(m.material_item_id) ?? "0",
          }));
          const short = shortages(needs);
          if (short.length > 0) fail("material_shortage", 409, { shortages: short });
          nextStatus = "released";
          detail = { reserved: needs.map((n) => ({ materialItemId: n.materialItemId, quantity: n.need })) };
          break;
        }
        case "issue": {
          const requested = input.lines && input.lines.length > 0
            ? input.lines.map((l) => ({ materialItemId: l.materialItemId, quantity: positiveQuantity(l.quantity) }))
            : materials
              .map((m) => ({ materialItemId: m.material_item_id, quantity: Decimal.max(new Decimal(m.required).minus(m.issued), 0).toFixed() }))
              .filter((l) => new Decimal(l.quantity).gt(0));
          if (requested.length === 0) fail("nothing_to_issue");
          const byId = new Map(materials.map((m) => [m.material_item_id, m]));
          for (const l of requested) if (!byId.has(l.materialItemId)) fail("material_not_on_order", 409, { materialItemId: l.materialItemId });
          const ids = requested.map((l) => l.materialItemId);
          const onHand = await lockMaterialStock(client, ids);
          const elsewhere = await reservedElsewhere(client, actor.businessId, orderId, ids);
          const short = shortages(requested.map((l) => ({
            materialItemId: l.materialItemId, name: byId.get(l.materialItemId)!.name, need: l.quantity,
            onHand: onHand.get(l.materialItemId) ?? "0", reservedElsewhere: elsewhere.get(l.materialItemId) ?? "0",
          })));
          if (short.length > 0) fail("material_shortage", 409, { shortages: short });
          let total = 0n;
          const issued: { materialItemId: string; quantity: string; valueRial: string }[] = [];
          for (const l of requested) {
            const relief = await relieveFungibleStock(client, { itemId: l.materialItemId, quantity: l.quantity });
            const value = BigInt(relief.value);
            total += value;
            issued.push({ materialItemId: l.materialItemId, quantity: l.quantity, valueRial: value.toString() });
            await client.query(
              `UPDATE item_production_order_materials SET issued_quantity = issued_quantity + $3, issued_value_rial = issued_value_rial + $4
                WHERE order_id = $1 AND material_item_id = $2`,
              [orderId, l.materialItemId, l.quantity, value.toString()],
            );
          }
          await client.query(`UPDATE item_production_orders SET material_cost_rial = material_cost_rial + $2 WHERE id = $1`, [orderId, total.toString()]);
          await post(client, actor, locationId, orderId, actionId, FASHION_PRODUCTION_EVENTS.materialsIssued, total);
          amount = total;
          nextStatus = "in_progress";
          detail = { issued };
          break;
        }
        case "return": {
          if (!input.lines || input.lines.length === 0) fail("nothing_to_return", 400);
          amount = await returnMaterials(client, actor, locationId, orderId, actionId, materials, input.lines, wip);
          detail = { returned: input.lines };
          break;
        }
        case "progress": {
          const after = applyProgress(stages, order.planned_quantity, input.stage, {
            completed: input.completed ?? undefined, scrapped: input.scrapped ?? undefined,
          });
          await writeStages(client, orderId, stages, after);
          const scrapped = totalScrapped(after);
          await client.query(`UPDATE item_production_orders SET scrapped_quantity = $2 WHERE id = $1`, [orderId, scrapped]);
          if (new Decimal(order.received_quantity).plus(scrapped).gt(order.planned_quantity)) fail("stage_quantity_exceeded");
          detail = { stage: input.stage, completed: input.completed ?? "0", scrapped: input.scrapped ?? "0", note: input.note ?? null };
          break;
        }
        case "rework": {
          const after = applyRework(stages, order.planned_quantity, input.fromStage, input.toStage, input.quantity);
          await writeStages(client, orderId, stages, after, input.toStage, positiveQuantity(input.quantity));
          detail = { fromStage: input.fromStage, toStage: input.toStage, quantity: positiveQuantity(input.quantity), note: input.note ?? null };
          break;
        }
        case "assign": {
          if (!stages.some((s) => s.code === input.stage)) fail("stage_not_found", 404);
          if (input.userId) {
            const member = await client.query(
              `SELECT 1 FROM users u WHERE u.id = $2 AND (u.business_id = $1 OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.business_id = $1))`, [actor.businessId, input.userId]);
            if (member.rowCount === 0) fail("assignee_not_member", 409);
          }
          await client.query(`UPDATE item_production_order_stages SET assignee_user_id = $3 WHERE order_id = $1 AND code = $2`,
            [orderId, input.stage, input.userId]);
          detail = { stage: input.stage, userId: input.userId };
          break;
        }
        case "cost": {
          if (!Number.isSafeInteger(input.amountRial) || input.amountRial <= 0) fail("invalid_amount", 400);
          if (input.stage && !stages.some((s) => s.code === input.stage)) fail("stage_not_found", 404);
          const value = BigInt(input.amountRial);
          await client.query(`UPDATE item_production_orders SET conversion_cost_rial = conversion_cost_rial + $2 WHERE id = $1`, [orderId, value.toString()]);
          await post(client, actor, locationId, orderId, actionId, FASHION_PRODUCTION_EVENTS.conversionAbsorbed, value);
          amount = value;
          detail = { kind: input.kind, stage: input.stage ?? null, note: input.note ?? null, supplierName: input.supplierName ?? null };
          break;
        }
        case "receive": {
          const qty = positiveQuantity(input.quantity);
          const receivable = receivableQuantity(stages, order.received_quantity);
          if (new Decimal(qty).gt(receivable)) fail("receipt_exceeds_finished", 409, { receivable });
          const receivedAfter = new Decimal(order.received_quantity).plus(qty).toFixed();
          const uncovered = materialCoversReceipt(materials.map((m) => ({
            materialItemId: m.material_item_id, quantityPerUnit: m.quantity_per_unit, issuedQuantity: m.issued, returnedQuantity: m.returned,
          })), receivedAfter);
          if (uncovered) fail("materials_not_issued", 409, uncovered);
          const outstanding = outstandingUnits(order.planned_quantity, order.scrapped_quantity, order.received_quantity);
          const value = receiptValue(wipBalance(wip), qty, outstanding);
          await restoreFungibleStock(client, { itemId: order.output_item_id, quantity: qty, value: value.toString() });
          await client.query(
            `UPDATE item_production_orders SET received_quantity = received_quantity + $2, received_value_rial = received_value_rial + $3 WHERE id = $1`,
            [orderId, qty, value.toString()],
          );
          await post(client, actor, locationId, orderId, actionId, FASHION_PRODUCTION_EVENTS.outputReceived, value);
          amount = value;
          detail = { quantity: qty, valueRial: value.toString() };
          if (new Decimal(outstanding).eq(qty)) nextStatus = "completed";
          break;
        }
        case "complete": {
          const outstanding = outstandingUnits(order.planned_quantity, order.scrapped_quantity, order.received_quantity);
          if (new Decimal(outstanding).gt(0)) fail("units_outstanding", 409, { outstanding });
          amount = await writeOffResidual(client, actor, locationId, orderId, actionId, wipBalance(wip));
          nextStatus = "completed";
          detail = { writtenOffRial: (amount ?? 0n).toString() };
          break;
        }
        case "cancel": {
          let returned = 0n;
          if (input.returns && input.returns.length > 0) {
            returned = await returnMaterials(client, actor, locationId, orderId, actionId, materials, input.returns, wip);
          }
          const residual = wipBalance({ ...wip, returnedValue: wip.returnedValue + returned });
          const writtenOff = await writeOffResidual(client, actor, locationId, orderId, actionId, residual);
          amount = returned + writtenOff;
          nextStatus = "cancelled";
          detail = { reason: input.reason, returns: input.returns ?? [], returnedRial: returned.toString(), writtenOffRial: writtenOff.toString() };
          break;
        }
      }
    } catch (error) {
      asProductionError(error);
    }

    await client.query(
      `UPDATE item_production_orders
          SET status = $2, version = version + 1, updated_at = now(),
              closed_at = CASE WHEN $2 IN ('completed', 'cancelled') THEN now() ELSE closed_at END
        WHERE id = $1`,
      [orderId, nextStatus],
    );
    await logAction(client, actor, orderId, actionId, input.action, input.idempotencyKey, detail, amount);
    return { ...(await orderDetail(client, actor.businessId, locationId, orderId)), duplicate: false };
  });
}

async function returnMaterials(
  client: PoolClient, actor: ProductionActor, locationId: string, orderId: string, actionId: string,
  materials: Awaited<ReturnType<typeof loadMaterials>>, lines: { materialItemId: string; quantity: string }[],
  wip: ReturnType<typeof wipOf>,
): Promise<bigint> {
  const byId = new Map(materials.map((m) => [m.material_item_id, m]));
  let total = 0n;
  for (const l of lines) {
    const line = byId.get(l.materialItemId);
    if (!line) fail("material_not_on_order", 409, { materialItemId: l.materialItemId });
    const qty = positiveQuantity(l.quantity);
    const value = materialReturnValue({
      issuedQuantity: line.issued, issuedValue: BigInt(line.issued_value),
      returnedQuantity: line.returned, returnedValue: BigInt(line.returned_value),
    }, qty);
    await restoreFungibleStock(client, { itemId: l.materialItemId, quantity: qty, value: value.toString() });
    await client.query(
      `UPDATE item_production_order_materials SET returned_quantity = returned_quantity + $3, returned_value_rial = returned_value_rial + $4
        WHERE order_id = $1 AND material_item_id = $2`,
      [orderId, l.materialItemId, qty, value.toString()],
    );
    total += value;
  }
  if (total > wipBalance(wip)) fail("return_exceeds_wip");
  await client.query(`UPDATE item_production_orders SET returned_value_rial = returned_value_rial + $2 WHERE id = $1`, [orderId, total.toString()]);
  await post(client, actor, locationId, orderId, actionId, FASHION_PRODUCTION_EVENTS.materialsReturned, total);
  return total;
}

async function writeOffResidual(client: PoolClient, actor: ProductionActor, locationId: string, orderId: string, actionId: string,
  residual: bigint): Promise<bigint> {
  if (residual <= 0n) return 0n;
  if (!actor.canWriteOff) fail("ledger_approval_required", 403, { residualRial: residual.toString() });
  await client.query(`UPDATE item_production_orders SET written_off_rial = written_off_rial + $2 WHERE id = $1`, [orderId, residual.toString()]);
  await post(client, actor, locationId, orderId, actionId, FASHION_PRODUCTION_EVENTS.wipWrittenOff, residual);
  return residual;
}

// ── report ────────────────────────────────────────────────────────────────

/**
 * The production summary for the branch plus the reconciliation the
 * accountant needs: the sum of every order's WIP subledger (whole business)
 * against the 1310 balance in the GL.
 */
export async function productionReport(actor: ProductionActor, locationId: string) {
  return withTenantTransaction(actor.businessId, async (client) => {
    const { rows: [s] } = await client.query<{
      open: string; completed: string; cancelled: string; planned: string; received: string; scrapped: string;
      received_value: string; wip: string; conversion: string; material: string;
    }>(
      `SELECT count(*) FILTER (WHERE status IN ('draft', 'released', 'in_progress'))::text AS open,
              count(*) FILTER (WHERE status = 'completed')::text AS completed,
              count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
              trim_scale(COALESCE(sum(planned_quantity), 0))::text AS planned,
              trim_scale(COALESCE(sum(received_quantity), 0))::text AS received,
              trim_scale(COALESCE(sum(scrapped_quantity), 0))::text AS scrapped,
              COALESCE(sum(received_value_rial), 0)::text AS received_value,
              COALESCE(sum(material_cost_rial + conversion_cost_rial - received_value_rial - returned_value_rial - written_off_rial), 0)::text AS wip,
              COALESCE(sum(conversion_cost_rial), 0)::text AS conversion,
              COALESCE(sum(material_cost_rial - returned_value_rial), 0)::text AS material
         FROM item_production_orders WHERE business_id = $1 AND location_id = $2`,
      [actor.businessId, locationId],
    );
    const { rows: [sub] } = await client.query<{ wip: string }>(
      `SELECT COALESCE(sum(material_cost_rial + conversion_cost_rial - received_value_rial - returned_value_rial - written_off_rial), 0)::text AS wip
         FROM item_production_orders WHERE business_id = $1`,
      [actor.businessId],
    );
    const { rows: [gl] } = await client.query<{ balance: string }>(
      `SELECT COALESCE(sum(jl.debit - jl.credit), 0)::text AS balance
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE a.business_id = $1 AND a.code = $2`,
      [actor.businessId, WELL_KNOWN_CODES.workInProgress],
    );
    const processed = new Decimal(s.received).plus(s.scrapped);
    return {
      openOrders: Number(s.open), completedOrders: Number(s.completed), cancelledOrders: Number(s.cancelled),
      plannedQuantity: s.planned, receivedQuantity: s.received, scrappedQuantity: s.scrapped,
      scrapRate: processed.gt(0) ? new Decimal(s.scrapped).div(processed).toDecimalPlaces(4).toFixed() : null,
      receivedValueRial: Number(s.received_value), averageUnitCostRial: unitCost(BigInt(s.received_value), s.received),
      materialCostRial: Number(s.material), conversionCostRial: Number(s.conversion), wipRial: Number(s.wip),
      reconciliation: {
        subledgerWipRial: Number(sub.wip), glWipRial: Number(gl.balance), reconciled: BigInt(sub.wip) === BigInt(gl.balance),
      },
    };
  });
}
