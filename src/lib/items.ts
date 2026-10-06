/**
 * Phase 21 Wave 1 — generic Item/Variant/Serial primitive (pure helpers).
 *
 * `menu_items`/`inventory_items` stay untouched in this wave (see
 * items-service.ts's doc comment) — these are the validation rules for the
 * new, parallel `items` model that later waves' gold/watch/accessories
 * modules build on.
 */

export type ItemKind = "simple" | "variant_parent" | "variant_child";
export type ItemTracking = "none" | "serial" | "weight" | "batch";

export const ITEM_KINDS: ItemKind[] = ["simple", "variant_parent", "variant_child"];
export const ITEM_TRACKINGS: ItemTracking[] = ["none", "serial", "weight", "batch"];

export interface VariantAttributeInput {
  name: string;
  value: string;
}

/** Mirrors the DB CHECK on items: a variant_child has a parent, no other kind does. */
export function validateItemKindParent(kind: ItemKind, parentItemId: string | null): string | null {
  if (kind === "variant_child" && !parentItemId) {
    return "کالای از نوع «تنوع فرزند» باید کالای والد داشته باشد.";
  }
  if (kind !== "variant_child" && parentItemId) {
    return "فقط کالای «تنوع فرزند» می‌تواند کالای والد داشته باشد.";
  }
  return null;
}

/** A variant child needs at least one attribute, each with a non-empty name/value, and no duplicate names. */
export function validateVariantAttributes(attributes: VariantAttributeInput[]): string[] {
  const errors: string[] = [];
  if (attributes.length === 0) {
    errors.push("حداقل یک ویژگی تنوع لازم است.");
    return errors;
  }
  const names = new Set<string>();
  for (const a of attributes) {
    const name = a.name?.trim();
    const value = a.value?.trim();
    if (!name) errors.push("نام ویژگی نمی‌تواند خالی باشد.");
    else if (names.has(name)) errors.push(`ویژگی «${name}» تکراری است.`);
    else names.add(name);
    if (!value) errors.push(`مقدار ویژگی «${name || "?"}» نمی‌تواند خالی باشد.`);
  }
  return errors;
}

/** A serial number is required, non-empty text — the physical identity of the unit. */
export function validateSerialNumber(serialNumber: string): string | null {
  if (!serialNumber?.trim()) return "شماره سریال نمی‌تواند خالی باشد.";
  return null;
}

export type SerialStatus =
  | "in_stock"
  | "reserved"
  | "sold"
  | "in_repair"
  | "supplier_returned"
  | "written_off";
export const SERIAL_STATUSES: SerialStatus[] = [
  "in_stock",
  "reserved",
  "sold",
  "in_repair",
  "supplier_returned",
  "written_off",
];

/**
 * Every transition is allowed except around the terminal states:
 * `sold` (no GENERIC flow un-sells a specific unit — the only way back is
 * the dedicated manager-approved serial return workflow in
 * watch-return-service.ts, which deliberately does not go through this
 * validator), `supplier_returned` (issue #795 — the physical unit left for
 * the supplier) and `written_off` (a damaged return the shop ate; its row
 * stays for provenance but it can never silently reappear on the shelf).
 * Entering `supplier_returned` is only valid from `in_stock` — the exact
 * unit must be on the shelf to hand back — and `written_off` can only be
 * entered by the return workflow itself.
 */
export function validateSerialStatusTransition(from: SerialStatus, to: SerialStatus): string | null {
  if (from === to) return null;
  if (from === "sold") {
    return "کالای فروخته‌شده را نمی‌توان به وضعیت دیگری بازگرداند.";
  }
  if (from === "supplier_returned") {
    return "کالای برگشت‌خورده به تأمین‌کننده را نمی‌توان به وضعیت دیگری بازگرداند.";
  }
  if (from === "written_off") {
    return "کالای ازرده‌خارج‌شده را نمی‌توان به وضعیت دیگری بازگرداند.";
  }
  if (to === "supplier_returned" && from !== "in_stock") {
    return "فقط کالای موجود در انبار را می‌توان به تأمین‌کننده برگرداند.";
  }
  if (to === "written_off") {
    return "ازرده‌خارج‌کردن فقط از مسیر مرجوعی و بازرسی انجام می‌شود.";
  }
  return null;
}

/** Phase 21 Wave 3 — the same "one physical unit, one lifecycle" shape as SerialStatus, for a tracking:'weight' item (a specific gold piece). */
export type WeightItemStatus = "in_stock" | "reserved" | "sold";
export const WEIGHT_ITEM_STATUSES: WeightItemStatus[] = ["in_stock", "reserved", "sold"];

/** `sold` is terminal here too — the same reasoning as a serialized unit: no Wave-3 flow un-sells a specific piece. */
export function validateWeightItemStatusTransition(
  from: WeightItemStatus,
  to: WeightItemStatus,
): string | null {
  if (from === "sold" && to !== "sold") {
    return "کالای فروخته‌شده را نمی‌توان به وضعیت دیگری بازگرداند.";
  }
  return null;
}
