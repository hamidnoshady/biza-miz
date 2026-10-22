import type { PoolClient } from "pg";
import { PERMISSIONS, type Permission } from "./permissions";

function normalized(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function same(left: unknown, right: unknown): boolean {
  return normalized(left) === normalized(right);
}

function sameNumeric(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? leftNumber === rightNumber
    : same(left, right);
}

/**
 * Resolve the minimum live capability set for the full-order hybrid event by
 * comparing its proposed snapshot to the locked local aggregate. Pure status
 * transitions use the same capabilities as the online kitchen/serve route;
 * any header, item-detail, modifier, add/remove, or void delta requires the
 * ordinary order mutation permission. This avoids treating the registry's
 * historical `orders.create` label as authorization for every replay.
 */
export async function orderStateReplayPermissions(
  client: PoolClient,
  locationId: string,
  payload: Record<string, unknown>,
): Promise<Permission[]> {
  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  const proposedOrder = payload.order;
  const proposedItems = payload.items;
  if (!orderId || !proposedOrder || typeof proposedOrder !== "object" || !Array.isArray(proposedItems)) {
    return [PERMISSIONS.ordersCreate];
  }
  const incomingOrder = proposedOrder as Record<string, unknown>;
  const { rows: orderRows } = await client.query<Record<string, unknown>>(
    `SELECT type::text,status::text,order_number::text AS order_number,table_id,customer_id,guest_count,note,
            discount_type,discount_value::text AS discount_value,subtotal::text AS subtotal,
            discount::text AS discount,service_charge::text AS service_charge,tax::text AS tax,
            total::text AS total,opened_at,opened_by,voided_reason,closed_by,closed_at
       FROM orders WHERE id=$1 AND location_id=$2 FOR UPDATE`,
    [orderId, locationId],
  );
  const currentOrder = orderRows[0];
  if (!currentOrder) return [PERMISSIONS.ordersCreate];

  const headerPairs: Array<[string, string]> = [
    ["type", "type"], ["status", "status"], ["orderNumber", "order_number"],
    ["tableId", "table_id"], ["customerId", "customer_id"], ["guestCount", "guest_count"],
    ["note", "note"], ["discountType", "discount_type"], ["discountValue", "discount_value"],
    ["subtotal", "subtotal"], ["discount", "discount"], ["serviceCharge", "service_charge"],
    ["tax", "tax"], ["total", "total"], ["openedAt", "opened_at"], ["openedBy", "opened_by"],
    ["voidedReason", "voided_reason"], ["closedBy", "closed_by"], ["closedAt", "closed_at"],
  ];
  const numericOrderFields = new Set([
    "guestCount", "discountValue", "subtotal", "discount", "serviceCharge", "tax", "total",
  ]);
  let structuralChange = headerPairs.some(([incoming, current]) =>
    !(numericOrderFields.has(incoming)
      ? sameNumeric(incomingOrder[incoming], currentOrder[current])
      : same(incomingOrder[incoming], currentOrder[current])),
  );

  const { rows: currentItems } = await client.query<Record<string, unknown>>(
    `SELECT id::text,menu_item_id::text,name_snapshot,unit_price::text,quantity,status::text,note,
            sent_to_kitchen_at,ready_at,created_at,void_reason
       FROM order_items WHERE order_id=$1 ORDER BY id`,
    [orderId],
  );
  const incomingById = new Map<string, Record<string, unknown>>();
  for (const item of proposedItems) {
    if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).id !== "string") {
      return [PERMISSIONS.ordersCreate];
    }
    incomingById.set((item as Record<string, unknown>).id as string, item as Record<string, unknown>);
  }
  if (incomingById.size !== proposedItems.length || incomingById.size !== currentItems.length) {
    structuralChange = true;
  }
  const currentIds = new Set(currentItems.map((item) => String(item.id)));
  if ([...incomingById.keys()].some((id) => !currentIds.has(id))) structuralChange = true;

  const changedStatusPermissions = new Set<Permission>();
  for (const current of currentItems) {
    const incoming = incomingById.get(String(current.id));
    if (!incoming) continue;
    const stablePairs: Array<[string, string]> = [
      ["menuItemId", "menu_item_id"], ["nameSnapshot", "name_snapshot"], ["unitPrice", "unit_price"],
      ["quantity", "quantity"], ["note", "note"], ["sentToKitchenAt", "sent_to_kitchen_at"],
      ["createdAt", "created_at"], ["voidReason", "void_reason"],
    ];
    if (stablePairs.some(([left, right]) => !(
      left === "quantity" || left === "unitPrice"
        ? sameNumeric(incoming[left], current[right])
        : same(incoming[left], current[right])
    ))) structuralChange = true;

    const currentStatus = String(current.status);
    const nextStatus = String(incoming.status ?? "");
    if (currentStatus !== nextStatus) {
      if (nextStatus === "preparing" || nextStatus === "ready") {
        changedStatusPermissions.add(PERMISSIONS.kitchenView);
      } else if (nextStatus === "served") {
        changedStatusPermissions.add(PERMISSIONS.ordersView);
      } else {
        structuralChange = true;
      }
    } else if (!same(incoming.readyAt, current.ready_at)) {
      structuralChange = true;
    }
  }

  const { rows: modifiers } = await client.query<Record<string, unknown>>(
    `SELECT m.id::text,m.order_item_id::text,m.modifier_id::text,m.name_snapshot,m.price_delta::text,m.quantity
       FROM order_item_modifiers m JOIN order_items i ON i.id=m.order_item_id
      WHERE i.order_id=$1 ORDER BY m.id`,
    [orderId],
  );
  const currentModifiersByItem = new Map<string, Record<string, unknown>[]>();
  for (const modifier of modifiers) {
    const owner = String(modifier.order_item_id);
    currentModifiersByItem.set(owner, [...(currentModifiersByItem.get(owner) ?? []), modifier]);
  }
  for (const [id, incoming] of incomingById) {
    const incomingModifiers = incoming.modifiers;
    if (!Array.isArray(incomingModifiers)) {
      structuralChange = true;
      continue;
    }
    const currentModifiers = currentModifiersByItem.get(id) ?? [];
    const normalizeModifier = (modifier: Record<string, unknown>) => [
      normalized(modifier.id), normalized(modifier.modifierId ?? modifier.modifier_id),
      normalized(modifier.nameSnapshot ?? modifier.name_snapshot),
      normalized(modifier.priceDelta ?? modifier.price_delta), normalized(modifier.quantity),
    ].join("|");
    const currentSet = currentModifiers.map(normalizeModifier).sort();
    const proposedSet = incomingModifiers
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
      .map(normalizeModifier).sort();
    if (currentSet.length !== proposedSet.length || currentSet.some((entry, i) => entry !== proposedSet[i])) {
      structuralChange = true;
    }
  }

  if (structuralChange) changedStatusPermissions.add(PERMISSIONS.ordersCreate);
  return changedStatusPermissions.size > 0
    ? [...changedStatusPermissions]
    : [PERMISSIONS.ordersView];
}
