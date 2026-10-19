import { isUuid } from "./uuid";
import { isValidIsoDate } from "./iso-date";
import { validateWarrantyMonths } from "./watch";
import Decimal from "decimal.js";
import { boundedRialText, positiveQuantityText, roundRial } from "./inventory-exact";

export function retailUuid(value: unknown): string {
  if (!isUuid(value)) throw new Error("invalid_uuid");
  return value.toLowerCase();
}
export function retailQuantity(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_quantity");
  const quantity = positiveQuantityText(value);
  if (new Decimal(quantity).gte("1000000000000000")) throw new Error("quantity_out_of_range");
  return quantity;
}
export function retailRial(value: unknown): string {
  // Legacy integrations may pass a safe integer; never recover an already
  // rounded unsafe Number by turning it into text.
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string") throw new Error("invalid_rial");
  return boundedRialText(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad_request");
  return value as Record<string, unknown>;
}
function optionalText(value: unknown, max = 2000): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new Error("invalid_text");
  return value.trim() || null;
}
function optionalUuid(value: unknown): string | null {
  return value == null || value === "" ? null : retailUuid(value);
}
function date(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (!isValidIsoDate(value)) throw new Error("invalid_date");
  return value;
}
function lines(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error("invalid_lines");
  return value;
}
export function requestKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("invalid_idempotency_key");
  return value.trim();
}
export function parseRetailPurchase(value: unknown) {
  const raw = object(value);
  const settlementMethod = raw.settlementMethod ?? "credit";
  if (settlementMethod !== "credit" && settlementMethod !== "cash" && settlementMethod !== "bank") throw new Error("invalid_settlement_method");
  const serialsSeen = new Set<string>();
  const parsed = lines(raw.lines).map((v) => {
    const line = object(v);
    const itemId = retailUuid(line.itemId);
    const quantity = retailQuantity(line.quantity);
    const unitCost = retailRial(line.unitCost);
    boundedRialText(roundRial(new Decimal(quantity).times(unitCost)));
    let serials: { serialNumber: string; warrantyMonths: number }[] | null = null;
    if (line.serials != null) {
      if (!Array.isArray(line.serials) || line.serials.length > 10000) throw new Error("invalid_serials");
      serials = line.serials.map((v) => {
        const serial = object(v);
        const serialNumber = optionalText(serial.serialNumber, 200);
        const warrantyMonths = serial.warrantyMonths ?? 0;
        if (!serialNumber || typeof warrantyMonths !== "number" || validateWarrantyMonths(warrantyMonths) !== null) throw new Error("invalid_serial");
        const key = `${itemId}:${serialNumber}`;
        if (serialsSeen.has(key)) throw new Error("duplicate_serial");
        serialsSeen.add(key);
        return { serialNumber, warrantyMonths };
      });
    }
    return { itemId, quantity, unitCost, serials, batchNumber: optionalText(line.batchNumber, 200),
      expiryDate: date(line.expiryDate), manufactureDate: date(line.manufactureDate), supplierReference: optionalText(line.supplierReference) };
  });
  boundedRialText(parsed.reduce((sum, l) => sum + BigInt(roundRial(new Decimal(l.quantity).times(l.unitCost))), 0n).toString());
  return { supplierId: optionalUuid(raw.supplierId), note: optionalText(raw.note), settlementMethod: settlementMethod as "cash" | "bank" | "credit", lines: parsed };
}
export function parseRetailReturn(value: unknown) {
  const raw = object(value);
  const settlementMethod = raw.settlementMethod ?? "accounts_payable";
  if (settlementMethod !== "accounts_payable" && settlementMethod !== "cash" && settlementMethod !== "bank" && settlementMethod !== "supplier_receivable") throw new Error("invalid_settlement_method");
  const reason = optionalText(raw.reason);
  if (!reason) throw new Error("missing_reason");
  return { purchaseId: optionalUuid(raw.purchaseId), reason, settlementMethod: settlementMethod as "cash" | "bank" | "accounts_payable" | "supplier_receivable", lines: lines(raw.lines).map(v => {
    const l = object(v);
    return { itemId: retailUuid(l.itemId), quantity: retailQuantity(l.quantity), purchaseItemId: optionalUuid(l.purchaseItemId),
      batchId: optionalUuid(l.batchId), serialId: optionalUuid(l.serialId), serialNumber: optionalText(l.serialNumber, 200) };
  }) };
}
