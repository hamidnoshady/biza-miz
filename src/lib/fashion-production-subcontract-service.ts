/**
 * GH #1567 Phase 6.3 — subcontracted stages of a fashion production order.
 *
 * Not a second engine: every action here runs INSIDE
 * `applyProductionOrderAction` (fashion-production-service.ts), so it shares
 * that transaction's idempotency key, its row lock on the order, its
 * `expectedVersion` check and its append-only action log. Stock moves only
 * through the same issue/return helpers the in-house path uses (F1 WAC), and
 * money only through the posting engine:
 *
 *   send material      → the ordinary issue into WIP + custody quantity
 *   return material    → the ordinary return out of WIP − custody quantity
 *   accept work        → stage progress + Dr 1310 / Cr 2100 (supplier-attributed)
 *   chargeback         → Dr 2100 / Cr 1310, order.recovered_rial
 *
 * The supplier is a canonical branch supplier alias; the payable it accrues
 * is settled by the ordinary A/P payment (`payBill`), which is why nothing
 * here pays anyone.
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { applyProgress, positiveQuantity, ProductionRuleError, totalScrapped, wipBalance, type StageState, type WipState } from "./fashion-production";
import { FASHION_PRODUCTION_EVENTS } from "./fashion-production-posting-rules";
import {
  assertCustodyReturn,
  cancelBlocker,
  closeBlockers,
  custodyBalance,
  custodyMovements,
  heldAtStage,
  inspectReceipt,
  subcontractActionAllowed,
  subcontractCharge,
  subcontractHeld,
  type CustodyLine,
  type SubcontractAction,
  type SubcontractStatus,
} from "./fashion-production-subcontract";

export const SUBCONTRACT_SOURCE_TYPE = "item_production_subcontract";

type MaterialLine = { materialItemId: string; quantity: string };

export type SubcontractOrderAction =
  | { action: "subcontract_create"; supplierId: string; stage: string; ratePerUnitRial: number; reference?: string | null }
  | { action: "subcontract_approve"; subcontractId: string }
  | { action: "subcontract_send"; subcontractId: string; quantity?: string | null; materials?: MaterialLine[] | null }
  | { action: "subcontract_receive"; subcontractId: string; accepted?: string | null; rework?: string | null;
      scrapped?: string | null; shortage?: string | null; note?: string | null }
  | { action: "subcontract_return_materials"; subcontractId: string; lines: MaterialLine[] }
  | { action: "subcontract_dispute"; subcontractId: string; note: string }
  | { action: "subcontract_resolve"; subcontractId: string; note: string; chargebackRial?: number | null }
  | { action: "subcontract_close"; subcontractId: string; declareRemainingLost?: boolean | null; chargebackRial?: number | null }
  | { action: "subcontract_cancel"; subcontractId: string; reason: string };

export interface SubcontractActor {
  businessId: string;
  userId: string | null;
  /** Holds `ledger.approve` — approving a subcontract commits the business to a payable. */
  canApprove: boolean;
}

/** What the order transaction hands over: its locked state and its own stock/ledger helpers. */
export interface SubcontractContext {
  client: PoolClient;
  actor: SubcontractActor;
  locationId: string;
  orderId: string;
  actionId: string;
  plannedQuantity: string;
  orderScrapped: string;
  orderReceived: string;
  stages: StageState[];
  /** The order's material lines (BOM snapshot) — quantity per unit per material. */
  materials: { material_item_id: string; quantity_per_unit: string }[];
  wip: WipState;
  fail: (code: string, status?: number, detail?: Record<string, unknown>) => never;
  issue: (lines: MaterialLine[]) => Promise<{ total: bigint; issued: { materialItemId: string; quantity: string; valueRial: string }[] }>;
  returnToStock: (lines: MaterialLine[]) => Promise<bigint>;
  writeStages: (before: StageState[], after: StageState[]) => Promise<void>;
  post: (eventType: string, amount: bigint, sourceType: string) => Promise<void>;
}

interface SubcontractRow {
  id: string; order_id: string; supplier_id: string; stage_code: string; reference: string; rate_per_unit_rial: string;
  status: SubcontractStatus; sent: string; accepted: string; scrapped: string; shortage: string; rework: string;
  accrued_rial: string; chargeback_rial: string; dispute_note: string | null; version: number;
}

function subcontractColumns(alias: string): string {
  const t = alias ? `${alias}.` : "";
  return `${t}id, ${t}order_id, ${t}supplier_id, ${t}stage_code, ${t}reference, ${t}rate_per_unit_rial::text AS rate_per_unit_rial, ${t}status,
  trim_scale(${t}sent_quantity)::text AS sent, trim_scale(${t}accepted_quantity)::text AS accepted,
  trim_scale(${t}scrapped_quantity)::text AS scrapped, trim_scale(${t}shortage_quantity)::text AS shortage,
  trim_scale(${t}rework_quantity)::text AS rework, ${t}accrued_rial::text AS accrued_rial, ${t}chargeback_rial::text AS chargeback_rial,
  ${t}dispute_note, ${t}version`;
}

function units(row: SubcontractRow) {
  return { sent: row.sent, accepted: row.accepted, scrapped: row.scrapped, shortage: row.shortage };
}

/** Every subcontract of the order (locked — the order row lock already serialises writers). */
export async function loadSubcontracts(client: PoolClient, orderId: string, lock: boolean): Promise<SubcontractRow[]> {
  const { rows } = await client.query<SubcontractRow>(
    `SELECT ${subcontractColumns("")} FROM item_production_subcontracts WHERE order_id = $1 ORDER BY created_at, id ${lock ? "FOR UPDATE" : ""}`,
    [orderId],
  );
  return rows;
}

async function loadCustody(client: PoolClient, subcontractId: string, materials: SubcontractContext["materials"]): Promise<CustodyLine[]> {
  const perUnit = new Map(materials.map((m) => [m.material_item_id, m.quantity_per_unit]));
  const { rows } = await client.query<{ material_item_id: string; sent: string; returned: string; consumed: string; lost: string }>(
    `SELECT material_item_id, trim_scale(sent_quantity)::text AS sent, trim_scale(returned_quantity)::text AS returned,
            trim_scale(consumed_quantity)::text AS consumed, trim_scale(lost_quantity)::text AS lost
       FROM item_production_subcontract_materials WHERE subcontract_id = $1 ORDER BY material_item_id`,
    [subcontractId],
  );
  return rows.map((r) => ({
    materialItemId: r.material_item_id, quantityPerUnit: perUnit.get(r.material_item_id) ?? "0",
    sent: r.sent, returned: r.returned, consumed: r.consumed, lost: r.lost,
  }));
}

/** Material of the order currently held by any of its subcontractors, per material. */
export async function custodyHeldByMaterial(client: PoolClient, orderId: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ material_item_id: string; held: string }>(
    `SELECT m.material_item_id,
            trim_scale(sum(m.sent_quantity - m.returned_quantity - m.consumed_quantity - m.lost_quantity))::text AS held
       FROM item_production_subcontract_materials m
       JOIN item_production_subcontracts s ON s.id = m.subcontract_id
      WHERE s.order_id = $1
      GROUP BY m.material_item_id`,
    [orderId],
  );
  return new Map(rows.map((r) => [r.material_item_id, r.held]));
}

/** Units at each stage held by the order's open subcontracts. */
export function heldUnitsAt(subcontracts: readonly SubcontractRow[], stageCode: string): string {
  return heldAtStage(subcontracts.map((s) => ({ ...units(s), stageCode: s.stage_code, status: s.status })), stageCode);
}

export function hasOpenSubcontract(subcontracts: readonly SubcontractRow[]): boolean {
  return subcontracts.some((s) => s.status === "draft" || s.status === "approved" || s.status === "disputed");
}

function chargebackAmount(ctx: SubcontractContext, raw: number | null | undefined): bigint {
  if (raw == null || raw === 0) return 0n;
  if (!Number.isSafeInteger(raw) || raw < 0) ctx.fail("invalid_amount", 400);
  const amount = BigInt(raw);
  if (amount > wipBalance(ctx.wip)) ctx.fail("chargeback_exceeds_wip", 409, { wipRial: wipBalance(ctx.wip).toString() });
  return amount;
}

async function applyChargeback(ctx: SubcontractContext, subcontractId: string, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  await ctx.client.query(`UPDATE item_production_orders SET recovered_rial = recovered_rial + $2 WHERE id = $1`, [ctx.orderId, amount.toString()]);
  await ctx.client.query(`UPDATE item_production_subcontracts SET chargeback_rial = chargeback_rial + $2 WHERE id = $1`,
    [subcontractId, amount.toString()]);
  await ctx.post(FASHION_PRODUCTION_EVENTS.subcontractChargeback, amount, SUBCONTRACT_SOURCE_TYPE);
}

/**
 * Applies one subcontract step. Returns what the order action log records:
 * the subcontract id (the A/P attribution path), the detail and the amount.
 */
export async function runSubcontractAction(ctx: SubcontractContext, input: SubcontractOrderAction):
  Promise<{ subcontractId: string; detail: Record<string, unknown>; amount: bigint | null; statusAfterOrder?: "in_progress" }> {
  const client = ctx.client;
  // An explicit annotation, so TypeScript narrows after `fail(...)` calls.
  const fail: (code: string, status?: number, detail?: Record<string, unknown>) => never = ctx.fail;

  if (input.action === "subcontract_create") {
    if (!ctx.stages.some((s) => s.code === input.stage)) fail("stage_not_found", 404);
    if (!Number.isSafeInteger(input.ratePerUnitRial) || input.ratePerUnitRial < 0) fail("invalid_amount", 400);
    // The canonical supplier alias of THIS branch (identity via its party).
    const { rows: [supplier] } = await client.query<{ id: string; is_active: boolean; name: string }>(
      `SELECT s.id, s.is_active, coalesce(p.name, s.name) AS name
         FROM suppliers s JOIN locations l ON l.id = s.location_id
         LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = l.business_id
        WHERE s.id = $1 AND s.location_id = $2 AND l.business_id = $3`,
      [input.supplierId, ctx.locationId, ctx.actor.businessId],
    );
    if (!supplier) fail("supplier_not_found", 404);
    if (!supplier.is_active) fail("supplier_inactive");
    const id = randomUUID();
    const reference = input.reference?.trim() || `SUB-${Date.now().toString(36).toUpperCase()}`;
    try {
      await client.query(
        `INSERT INTO item_production_subcontracts (id, business_id, order_id, supplier_id, stage_code, reference, rate_per_unit_rial, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.actor.businessId, ctx.orderId, supplier.id, input.stage, reference, input.ratePerUnitRial, ctx.actor.userId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") fail("reference_taken");
      throw error;
    }
    return {
      subcontractId: id, amount: null,
      detail: { subcontractId: id, reference, supplierId: supplier.id, supplierName: supplier.name, stage: input.stage, ratePerUnitRial: input.ratePerUnitRial },
    };
  }

  const all = await loadSubcontracts(client, ctx.orderId, true);
  const sc = all.find((s) => s.id === input.subcontractId);
  if (!sc) fail("subcontract_not_found", 404);
  if (!subcontractActionAllowed(sc.status, input.action as SubcontractAction)) {
    fail("subcontract_action_not_allowed", 409, { status: sc.status, action: input.action });
  }
  const stageIndex = ctx.stages.findIndex((s) => s.code === sc.stage_code);
  if (stageIndex < 0) fail("stage_not_found", 404);
  const base = { subcontractId: sc.id, reference: sc.reference, stage: sc.stage_code };
  const setStatus = (status: SubcontractStatus, closing = false) => client.query(
    `UPDATE item_production_subcontracts
        SET status = $2, version = version + 1, updated_at = now(),
            closed_at = CASE WHEN $3::boolean THEN now() ELSE closed_at END
      WHERE id = $1`,
    [sc.id, status, closing]);

  switch (input.action) {
    case "subcontract_approve": {
      if (!ctx.actor.canApprove) fail("subcontract_approval_required", 403);
      await client.query(`UPDATE item_production_subcontracts SET approved_by = $2, approved_at = now() WHERE id = $1`, [sc.id, ctx.actor.userId]);
      await setStatus("approved");
      return { subcontractId: sc.id, amount: null, detail: { ...base, approvedBy: ctx.actor.userId } };
    }

    case "subcontract_send": {
      const qty = input.quantity ? positiveQuantity(input.quantity) : null;
      const materials = (input.materials ?? []).map((l) => ({ materialItemId: l.materialItemId, quantity: positiveQuantity(l.quantity) }));
      if (!qty && materials.length === 0) fail("nothing_to_send", 400);
      if (qty) {
        // Only units waiting at the stage and not already with a subcontractor.
        const stage = ctx.stages[stageIndex];
        const inflow = stageIndex === 0 ? new Decimal(ctx.plannedQuantity) : new Decimal(ctx.stages[stageIndex - 1].completed);
        const free = inflow.minus(stage.completed).minus(stage.scrapped).minus(heldUnitsAt(all, sc.stage_code));
        if (new Decimal(qty).gt(free)) fail("subcontract_quantity_exceeded", 409, { available: Decimal.max(free, 0).toFixed() });
      }
      let issuedTotal = 0n;
      let issued: { materialItemId: string; quantity: string; valueRial: string }[] = [];
      if (materials.length > 0) {
        const result = await ctx.issue(materials);
        issuedTotal = result.total;
        issued = result.issued;
        for (const l of materials) {
          await client.query(
            `INSERT INTO item_production_subcontract_materials (subcontract_id, business_id, material_item_id, sent_quantity)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (subcontract_id, material_item_id) DO UPDATE SET sent_quantity = item_production_subcontract_materials.sent_quantity + EXCLUDED.sent_quantity`,
            [sc.id, ctx.actor.businessId, l.materialItemId, l.quantity],
          );
        }
      }
      if (qty) await client.query(`UPDATE item_production_subcontracts SET sent_quantity = sent_quantity + $2 WHERE id = $1`, [sc.id, qty]);
      await setStatus(sc.status);
      return {
        subcontractId: sc.id, amount: issuedTotal > 0n ? issuedTotal : null,
        detail: { ...base, quantity: qty ?? "0", materials: issued },
        ...(materials.length > 0 ? { statusAfterOrder: "in_progress" as const } : {}),
      };
    }

    case "subcontract_receive": {
      const inspection = inspectReceipt(units(sc), input);
      const custody = await loadCustody(client, sc.id, ctx.materials);
      const movements = custodyMovements(custody, inspection);
      const toScrap = new Decimal(inspection.scrapped).plus(inspection.shortage);
      if (new Decimal(inspection.accepted).gt(0) || toScrap.gt(0)) {
        const after = applyProgress(ctx.stages, ctx.plannedQuantity, sc.stage_code, {
          completed: new Decimal(inspection.accepted).gt(0) ? inspection.accepted : undefined,
          scrapped: toScrap.gt(0) ? toScrap.toFixed() : undefined,
        });
        await ctx.writeStages(ctx.stages, after);
        const scrapped = totalScrapped(after);
        if (new Decimal(ctx.orderReceived).plus(scrapped).gt(ctx.plannedQuantity)) fail("stage_quantity_exceeded");
        await client.query(`UPDATE item_production_orders SET scrapped_quantity = $2 WHERE id = $1`, [ctx.orderId, scrapped]);
      }
      if (new Decimal(inspection.rework).gt(0)) {
        await client.query(`UPDATE item_production_order_stages SET rework_quantity = rework_quantity + $3 WHERE order_id = $1 AND code = $2`,
          [ctx.orderId, sc.stage_code, inspection.rework]);
      }
      for (const m of movements) {
        await client.query(
          `UPDATE item_production_subcontract_materials SET consumed_quantity = consumed_quantity + $3, lost_quantity = lost_quantity + $4
            WHERE subcontract_id = $1 AND material_item_id = $2`,
          [sc.id, m.materialItemId, m.consumed, m.lost],
        );
      }
      const charge = subcontractCharge(BigInt(sc.rate_per_unit_rial), inspection.accepted);
      await client.query(
        `UPDATE item_production_subcontracts
            SET accepted_quantity = accepted_quantity + $2, scrapped_quantity = scrapped_quantity + $3,
                shortage_quantity = shortage_quantity + $4, rework_quantity = rework_quantity + $5, accrued_rial = accrued_rial + $6
          WHERE id = $1`,
        [sc.id, inspection.accepted, inspection.scrapped, inspection.shortage, inspection.rework, charge.toString()],
      );
      if (charge > 0n) {
        await client.query(`UPDATE item_production_orders SET conversion_cost_rial = conversion_cost_rial + $2 WHERE id = $1`, [ctx.orderId, charge.toString()]);
        await ctx.post(FASHION_PRODUCTION_EVENTS.subcontractAccrued, charge, SUBCONTRACT_SOURCE_TYPE);
      }
      await setStatus(sc.status);
      return {
        subcontractId: sc.id, amount: charge > 0n ? charge : null,
        detail: { ...base, ...inspection, chargeRial: charge.toString(), custody: movements, note: input.note ?? null },
      };
    }

    case "subcontract_return_materials": {
      if (!input.lines || input.lines.length === 0) fail("nothing_to_return", 400);
      const custody = await loadCustody(client, sc.id, ctx.materials);
      const byId = new Map(custody.map((c) => [c.materialItemId, c]));
      const lines = input.lines.map((l) => ({ materialItemId: l.materialItemId, quantity: positiveQuantity(l.quantity) }));
      for (const l of lines) {
        const line = byId.get(l.materialItemId);
        if (!line) fail("material_not_in_custody", 409, { materialItemId: l.materialItemId });
        assertCustodyReturn(line, l.quantity);
      }
      const value = await ctx.returnToStock(lines);
      for (const l of lines) {
        await client.query(
          `UPDATE item_production_subcontract_materials SET returned_quantity = returned_quantity + $3 WHERE subcontract_id = $1 AND material_item_id = $2`,
          [sc.id, l.materialItemId, l.quantity],
        );
      }
      await setStatus(sc.status);
      return { subcontractId: sc.id, amount: value, detail: { ...base, returned: lines, valueRial: value.toString() } };
    }

    case "subcontract_dispute": {
      const note = input.note.trim();
      if (note.length < 3) fail("bad_request", 400);
      await client.query(`UPDATE item_production_subcontracts SET dispute_note = $2 WHERE id = $1`, [sc.id, note]);
      await setStatus("disputed");
      return { subcontractId: sc.id, amount: null, detail: { ...base, note } };
    }

    case "subcontract_resolve": {
      const note = input.note.trim();
      if (note.length < 3) fail("bad_request", 400);
      const chargeback = chargebackAmount(ctx, input.chargebackRial);
      await applyChargeback(ctx, sc.id, chargeback);
      await setStatus("approved");
      return { subcontractId: sc.id, amount: chargeback > 0n ? chargeback : null,
        detail: { ...base, note, chargebackRial: chargeback.toString() } };
    }

    case "subcontract_close": {
      const custody = await loadCustody(client, sc.id, ctx.materials);
      const blockers = closeBlockers(units(sc), custody, Boolean(input.declareRemainingLost));
      if (blockers) fail("subcontract_not_settled", 409, blockers);
      const declaredLost: { materialItemId: string; quantity: string }[] = [];
      if (input.declareRemainingLost) {
        for (const line of custody) {
          const held = custodyBalance(line);
          if (new Decimal(held).lte(0)) continue;
          declaredLost.push({ materialItemId: line.materialItemId, quantity: held });
          await client.query(
            `UPDATE item_production_subcontract_materials SET lost_quantity = lost_quantity + $3 WHERE subcontract_id = $1 AND material_item_id = $2`,
            [sc.id, line.materialItemId, held],
          );
        }
      }
      const chargeback = chargebackAmount(ctx, input.chargebackRial);
      await applyChargeback(ctx, sc.id, chargeback);
      await setStatus("closed", true);
      return { subcontractId: sc.id, amount: chargeback > 0n ? chargeback : null,
        detail: { ...base, declaredLost, chargebackRial: chargeback.toString(), accruedRial: sc.accrued_rial } };
    }

    case "subcontract_cancel": {
      const custody = await loadCustody(client, sc.id, ctx.materials);
      const blocker = cancelBlocker({ ...units(sc), accrued: BigInt(sc.accrued_rial), custodyHeld: custody.some((c) => new Decimal(custodyBalance(c)).gt(0)) });
      if (blocker) fail(blocker, 409);
      // Units still out come back undone: they simply stop being "sent".
      const recalled = subcontractHeld(units(sc));
      if (new Decimal(recalled).gt(0)) {
        await client.query(`UPDATE item_production_subcontracts SET sent_quantity = sent_quantity - $2 WHERE id = $1`, [sc.id, recalled]);
      }
      await setStatus("cancelled", true);
      return { subcontractId: sc.id, amount: null, detail: { ...base, reason: input.reason.trim(), recalledQuantity: recalled } };
    }
  }
  throw new ProductionRuleError("action_not_allowed");
}

/** Subcontracts of an order for the detail screen, with the supplier's canonical name and custody. */
export async function subcontractDetails(client: PoolClient, orderId: string) {
  const { rows } = await client.query<SubcontractRow & { supplier_name: string; approved_by_name: string | null }>(
    `SELECT ${subcontractColumns("sc")},
            coalesce(p.name, s.name) AS supplier_name, u.full_name AS approved_by_name
       FROM item_production_subcontracts sc
       JOIN suppliers s ON s.id = sc.supplier_id
       LEFT JOIN locations l ON l.id = s.location_id
       LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = l.business_id
       LEFT JOIN users u ON u.id = sc.approved_by
      WHERE sc.order_id = $1
      ORDER BY sc.created_at, sc.id`,
    [orderId],
  );
  const custody = await client.query<{ subcontract_id: string; material_item_id: string; name: string; unit: string | null;
    sent: string; returned: string; consumed: string; lost: string }>(
    `SELECT m.subcontract_id, m.material_item_id, i.name, i.unit, trim_scale(m.sent_quantity)::text AS sent,
            trim_scale(m.returned_quantity)::text AS returned, trim_scale(m.consumed_quantity)::text AS consumed,
            trim_scale(m.lost_quantity)::text AS lost
       FROM item_production_subcontract_materials m
       JOIN item_production_subcontracts sc ON sc.id = m.subcontract_id
       JOIN items i ON i.id = m.material_item_id
      WHERE sc.order_id = $1 ORDER BY i.name`,
    [orderId],
  );
  return rows.map((r) => ({
    id: r.id, reference: r.reference, supplierId: r.supplier_id, supplierName: r.supplier_name, stageCode: r.stage_code,
    ratePerUnitRial: Number(r.rate_per_unit_rial), status: r.status, approvedByName: r.approved_by_name,
    sentQuantity: r.sent, acceptedQuantity: r.accepted, scrappedQuantity: r.scrapped, shortageQuantity: r.shortage,
    reworkQuantity: r.rework, heldQuantity: subcontractHeld(units(r)),
    accruedRial: Number(r.accrued_rial), chargebackRial: Number(r.chargeback_rial), disputeNote: r.dispute_note,
    custody: custody.rows.filter((c) => c.subcontract_id === r.id).map((c) => ({
      materialItemId: c.material_item_id, name: c.name, unit: c.unit, sentQuantity: c.sent, returnedQuantity: c.returned,
      consumedQuantity: c.consumed, lostQuantity: c.lost,
      heldQuantity: custodyBalance({ sent: c.sent, returned: c.returned, consumed: c.consumed, lost: c.lost }),
    })),
  }));
}

/** Active supplier aliases of the branch, for the assignment picker. */
export async function branchSuppliers(client: PoolClient, businessId: string, locationId: string) {
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT s.id, coalesce(p.name, s.name) AS name
       FROM suppliers s JOIN locations l ON l.id = s.location_id
       LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = l.business_id
      WHERE s.location_id = $1 AND l.business_id = $2 AND s.is_active
      ORDER BY 2 LIMIT 500`,
    [locationId, businessId],
  );
  return rows;
}
