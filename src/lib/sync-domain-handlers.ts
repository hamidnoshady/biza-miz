import type { PoolClient } from "pg";
import type { Role } from "./auth";
import { createCustomerReturn } from "./customer-return-service";
import { positiveQuantityText, quantityText, rialText } from "./inventory-exact";
import { createItemStockCount, reverseItemStockCount } from "./item-stock-count-service";
import { reverseEntryInTransaction } from "./manual-journal-service";
import { completeOrderPayment, completeSplitOrderPayment, PAYMENT_METHODS } from "./payment-service";
import { PAYMENT_SETTLEMENTS, type ResolvedTender } from "./payment-methods";
import type { Rial } from "./money";
import { createDraftPurchaseInTransaction } from "./purchase-service";
import { PURCHASE_SETTLEMENT_METHODS, receivePurchaseInTransaction } from "./purchase-receive-service";
import { recordProductionRun, reverseProductionRun } from "./production-service";
import { createStockCount, reverseStockCount } from "./stock-count-service";
import { createSupplierReturn } from "./supplier-return-service";
import {
  createInventoryTransfer,
  shipInventoryTransfer,
  receiveInventoryTransfer,
  cancelInventoryTransfer,
} from "./transfer-service";
import { isWasteReason, recordWasteInTransaction } from "./waste-service";
import type { SyncEventDefinition } from "./sync-event-registry";
import { applyOrderState, OrderStateTerminal } from "./order-state-sync";
import { applyShiftReplay, parseShiftSyncPayload } from "./shift-sync";
import { amendClosedOrder, OrderAmendmentError } from "./order-amendment-service";
import { validateAmendment, type AmendmentInput } from "./order-amendments";

export interface SyncDomainContext {
  client: PoolClient;
  businessId: string;
  locationId: string;
  actor: { userId: string; role: Role };
  clientEventId: string;
  payload: Record<string, unknown>;
  definition: SyncEventDefinition;
  /** When the action happened on the side that made it (ISO). */
  occurredAt?: string;
}

export interface SyncDomainEffect {
  effectType: string;
  effectId: string | null;
  result?: Record<string, unknown>;
}

export class SyncPayloadError extends Error {
  constructor(readonly code = "invalid_payload") {
    super(code);
    this.name = "SyncPayloadError";
  }
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) throw new SyncPayloadError(`invalid_${field}`);
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new SyncPayloadError(`invalid_${field}`);
  return value.trim() || null;
}

function array(payload: Record<string, unknown>, field: string, allowEmpty = false): Record<string, unknown>[] {
  const value = payload[field];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 500) throw new SyncPayloadError(`invalid_${field}`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SyncPayloadError(`invalid_${field}`);
    return entry as Record<string, unknown>;
  });
}

function validInstant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function isoDate(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SyncPayloadError("invalid_entryDate");
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new SyncPayloadError(code);
  return value as T;
}

function exactInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SyncPayloadError(code);
  return value;
}

async function assertTransferLocation(
  client: PoolClient,
  businessId: string,
  locationId: string,
  transferId: string,
  leg: "source" | "destination",
): Promise<void> {
  const column = leg === "source" ? "source_location_id" : "destination_location_id";
  const transfer = await client.query(
    `SELECT 1 FROM inventory_transfers WHERE id=$1 AND business_id=$2 AND ${column}=$3`,
    [transferId, businessId, locationId],
  );
  if (transfer.rowCount !== 1) throw new Error("transfer_location_scope_mismatch");
}

export async function applySyncDomainHandler(context: SyncDomainContext): Promise<SyncDomainEffect> {
  const { client, businessId, locationId, actor, clientEventId, payload } = context;
  switch (context.definition.handler) {
    case "order.payment.completed": {
      const method = enumValue(payload.method, PAYMENT_METHODS, "invalid_method");
      const result = await completeOrderPayment({
        client,
        businessId,
        locationId,
        orderId: requiredString(payload, "orderId"),
        method,
        reference: optionalString(payload, "reference"),
        customerId: optionalString(payload, "customerId"),
        tipAmount: payload.tipAmount === undefined ? 0 : exactInteger(payload.tipAmount, "invalid_tipAmount"),
        businessDate: optionalString(payload, "businessDate") ?? undefined,
        receivedBy: actor.userId,
        idempotencyKey: clientEventId,
      });
      return { effectType: "order_payment", effectId: requiredString(payload, "orderId"), result: { amount: result.amount, duplicate: Boolean(result.duplicate) } };
    }
    case "order.payment.completed.v2": {
      const tenders: ResolvedTender[] = array(payload, "tenders", true).map((tender) => ({
        methodId: optionalString(tender, "methodId"),
        settlement: enumValue(tender.settlement, PAYMENT_SETTLEMENTS, "invalid_settlement"),
        amount: exactInteger(tender.amount, "invalid_amount") as Rial,
        reference: optionalString(tender, "reference"),
      }));
      const result = await completeSplitOrderPayment({
        client, businessId, locationId,
        orderId: requiredString(payload, "orderId"), tenders,
        customerId: optionalString(payload, "customerId"),
        tipAmount: payload.tipAmount === undefined ? 0 : exactInteger(payload.tipAmount, "invalid_tipAmount"),
        businessDate: optionalString(payload, "businessDate") ?? undefined,
        receivedBy: actor.userId, idempotencyKey: clientEventId,
        // The paying side's own instant and journal date, so a sale synced
        // after midnight is still on the day it was made (migration 0190).
        settledAt: validInstant(context.occurredAt),
        entryDate: isoDate(optionalString(payload, "entryDate")),
      });
      return { effectType: "order_payment", effectId: requiredString(payload, "orderId"), result: { amount: result.amount, duplicate: Boolean(result.duplicate) } };
    }
    case "order.state.synced": {
      try {
        const result = await applyOrderState(client, { locationId, actor, payload });
        return { effectType: "order_state", effectId: result.orderId, result: { outcome: result.outcome } };
      } catch (error) {
        if (error instanceof OrderStateTerminal) throw new SyncPayloadError(error.message);
        throw error;
      }
    }
    case "order.amendment.posted": {
      const orderId = requiredString(payload, "orderId");
      const validated = validateAmendment((payload.input ?? {}) as AmendmentInput);
      if (!validated.ok) throw new SyncPayloadError("invalid_input");
      const newItemIds = payload.newItemIds === undefined ? [] : payload.newItemIds;
      if (!Array.isArray(newItemIds) || newItemIds.some((id) => typeof id !== "string")) {
        throw new SyncPayloadError("invalid_newItemIds");
      }
      try {
        const result = await amendClosedOrder(client, {
          businessId,
          locationId,
          orderId,
          actorId: actor.userId,
          input: validated.value,
          newItemIds: newItemIds as string[],
        });
        return { effectType: "order_amendment", effectId: result.id, result: { newTotal: result.newTotal } };
      } catch (error) {
        // Not here yet (or not paid yet) waits; any other refusal is final.
        if (error instanceof OrderAmendmentError && !context.definition.dependencyErrors.includes(error.message)) {
          throw new SyncPayloadError(error.message);
        }
        throw error;
      }
    }
    case "order.customer_return.created": {
      const refundMethod = enumValue(payload.refundMethod, ["cash", "card", "card_to_card", "online", "credit"] as const, "invalid_refundMethod");
      const result = await createCustomerReturn(client, {
        businessId,
        locationId,
        orderId: requiredString(payload, "orderId"),
        refundMethod,
        refundAmount: rialText(requiredString(payload, "refundAmount")),
        reason: requiredString(payload, "reason"),
        idempotencyKey: clientEventId,
        createdBy: actor.userId,
        lines: array(payload, "lines").map((line) => ({
          orderItemId: requiredString(line, "orderItemId"),
          quantity: positiveQuantityText(requiredString(line, "quantity")),
          disposition: enumValue(line.disposition, ["restockable", "discarded"] as const, "invalid_disposition"),
        })),
      });
      return { effectType: "customer_return", effectId: result.id, result: { refundAmount: result.refundAmount, recoveredValue: result.recoveredValue, duplicate: result.duplicate } };
    }
    case "accounting.manual_journal.reversed": {
      const result = await reverseEntryInTransaction(client, {
        businessId,
        locationId,
        entryId: requiredString(payload, "entryId"),
        actorId: actor.userId,
        memo: optionalString(payload, "memo"),
        entryDate: optionalString(payload, "entryDate"),
      });
      return { effectType: "journal_reversal", effectId: result.entryId };
    }
    case "inventory.purchase.created": {
      const result = await createDraftPurchaseInTransaction(client, {
        locationId,
        purchaseId: optionalString(payload, "purchaseId") ?? undefined,
        supplierId: optionalString(payload, "supplierId"),
        note: optionalString(payload, "note") ?? undefined,
        purchaseDate: optionalString(payload, "purchaseDate"),
        createdBy: actor.userId,
        items: array(payload, "items").map((line) => ({
          inventoryItemId: requiredString(line, "inventoryItemId"),
          purchaseQty: requiredString(line, "purchaseQty"),
          totalCost: requiredString(line, "totalCost"),
        })),
      });
      return { effectType: "purchase", effectId: result.id, result: { total: result.total } };
    }
    case "inventory.purchase.received": {
      const result = await receivePurchaseInTransaction(client, {
        businessId,
        locationId,
        purchaseId: requiredString(payload, "purchaseId"),
        settlementMethod: enumValue(payload.settlementMethod, PURCHASE_SETTLEMENT_METHODS, "invalid_settlementMethod"),
        supplierId: optionalString(payload, "supplierId"),
        createdBy: actor.userId,
      });
      return { effectType: "purchase_receipt", effectId: result.id, result: { inventoryEventId: result.inventoryEventId, duplicate: result.duplicate } };
    }
    case "inventory.supplier_return.created": {
      const result = await createSupplierReturn(client, {
        businessId,
        locationId,
        purchaseId: requiredString(payload, "purchaseId"),
        settlementMethod: enumValue(payload.settlementMethod, ["accounts_payable", "cash", "bank", "supplier_receivable"] as const, "invalid_settlementMethod"),
        reason: requiredString(payload, "reason"),
        idempotencyKey: clientEventId,
        createdBy: actor.userId,
        lines: array(payload, "lines").map((line) => ({
          purchaseItemId: requiredString(line, "purchaseItemId"),
          inventoryLotId: optionalString(line, "inventoryLotId"),
          quantity: positiveQuantityText(requiredString(line, "quantity")),
        })),
      });
      return { effectType: "supplier_return", effectId: result.id, result: { value: result.value, duplicate: result.duplicate } };
    }
    case "inventory.transfer.created": {
      const result = await createInventoryTransfer(client, {
        businessId,
        sourceLocationId: locationId,
        transferId: optionalString(payload, "transferId") ?? undefined,
        destinationLocationId: requiredString(payload, "destinationLocationId"),
        note: optionalString(payload, "note"),
        idempotencyKey: clientEventId,
        createdBy: actor.userId,
        lines: array(payload, "lines").map((line) => ({
          sourceInventoryItemId: requiredString(line, "sourceInventoryItemId"),
          destinationInventoryItemId: requiredString(line, "destinationInventoryItemId"),
          quantity: positiveQuantityText(requiredString(line, "quantity")),
        })),
      });
      return { effectType: "inventory_transfer", effectId: result.id, result: { duplicate: result.duplicate } };
    }
    case "inventory.transfer.shipped": {
      const transferId = requiredString(payload, "transferId");
      await assertTransferLocation(client, businessId, locationId, transferId, "source");
      const result = await shipInventoryTransfer(client, { businessId, transferId, actorId: actor.userId });
      return { effectType: "transfer_ship", effectId: result.eventId, result: { value: result.value } };
    }
    case "inventory.transfer.received": {
      const transferId = requiredString(payload, "transferId");
      await assertTransferLocation(client, businessId, locationId, transferId, "destination");
      const result = await receiveInventoryTransfer(client, { businessId, transferId, actorId: actor.userId });
      return { effectType: "transfer_receive", effectId: result.eventId, result: { value: result.value } };
    }
    case "inventory.transfer.cancelled": {
      const transferId = requiredString(payload, "transferId");
      await assertTransferLocation(client, businessId, locationId, transferId, "source");
      const result = await cancelInventoryTransfer(client, { businessId, transferId, actorId: actor.userId });
      return { effectType: "transfer_cancel", effectId: result.eventId, result: { value: result.value } };
    }
    case "inventory.waste.recorded": {
      const reason = payload.reason;
      if (!isWasteReason(reason)) throw new SyncPayloadError("invalid_reason");
      const itemId = requiredString(payload, "inventoryItemId");
      const owned = await client.query("SELECT 1 FROM inventory_items WHERE id=$1 AND location_id=$2 AND is_active", [itemId, locationId]);
      if (owned.rowCount !== 1) throw new Error("item_not_found");
      const result = await recordWasteInTransaction(client, {
        businessId,
        locationId,
        inventoryItemId: itemId,
        quantity: positiveQuantityText(requiredString(payload, "quantity")),
        reason,
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
        idempotencyKey: clientEventId,
      });
      return { effectType: "waste", effectId: result.inventoryEventId, result: { postedCost: result.postedCost, duplicate: Boolean(result.duplicate) } };
    }
    case "inventory.stock_count.recorded": {
      const result = await createStockCount(client, {
        businessId,
        locationId,
        countId: optionalString(payload, "countId") ?? undefined,
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
        lines: array(payload, "lines").map((line) => ({
          inventoryItemId: requiredString(line, "inventoryItemId"),
          countedQty: requiredString(line, "countedQty"),
        })),
      });
      return { effectType: "stock_count", effectId: result.id };
    }
    case "inventory.stock_count.reversed": {
      const result = await reverseStockCount(client, {
        businessId,
        locationId,
        countId: requiredString(payload, "countId"),
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
      });
      return { effectType: "stock_count_reversal", effectId: result.id };
    }
    case "retail.stock_count.recorded": {
      const result = await createItemStockCount(client, {
        businessId,
        locationId,
        countId: optionalString(payload, "countId") ?? undefined,
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
        lines: array(payload, "lines").map((line) => ({
          itemId: requiredString(line, "itemId"),
          countedQty: requiredString(line, "countedQty"),
        })),
      });
      return { effectType: "retail_stock_count", effectId: result.id, result: { shortage: result.shortage, surplus: result.surplus } };
    }
    case "retail.stock_count.reversed": {
      const result = await reverseItemStockCount(client, {
        businessId,
        locationId,
        countId: requiredString(payload, "countId"),
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
      });
      return { effectType: "retail_stock_count_reversal", effectId: result.id };
    }
    case "inventory.production.recorded": {
      const result = await recordProductionRun(client, {
        businessId,
        locationId,
        runId: optionalString(payload, "runId") ?? undefined,
        formulaId: requiredString(payload, "formulaId"),
        batches: positiveQuantityText(requiredString(payload, "batches")),
        outputQuantity: payload.outputQuantity == null ? null : positiveQuantityText(requiredString(payload, "outputQuantity")),
        conversionCostRial: payload.conversionCostRial == null ? null : rialText(requiredString(payload, "conversionCostRial")),
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
        idempotencyKey: clientEventId,
      });
      return { effectType: "production_run", effectId: result.id, result: { totalCostRial: result.totalCostRial, duplicate: Boolean(result.duplicate) } };
    }
    case "inventory.production.reversed": {
      const result = await reverseProductionRun(client, {
        businessId,
        locationId,
        runId: requiredString(payload, "runId"),
        note: optionalString(payload, "note"),
        createdBy: actor.userId,
      });
      return { effectType: "production_reversal", effectId: result.id };
    }
    case "shift.opened":
    case "shift.closed": {
      const shift = parseShiftSyncPayload(payload);
      if (!shift) throw new SyncPayloadError("invalid_shift");
      const effectId = await applyShiftReplay(client, businessId, locationId, shift);
      return { effectType: context.definition.handler === "shift.closed" ? "shift_close" : "shift_open", effectId };
    }
    default:
      throw new Error(`sync_handler_not_implemented:${context.definition.handler}`);
  }
}

export function syncErrorCode(error: unknown): string {
  if (error instanceof SyncPayloadError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message.split(":", 1)[0] : "apply_failed";
}
