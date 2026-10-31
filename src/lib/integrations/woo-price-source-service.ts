import { query } from "../db";
import type { ConnectionRow } from "./connections-service";

/** Values remain integer Rial, including lists labelled IRT by the price editor. */
export async function resolveMappedWooPrice(
  businessId: string,
  connection: Pick<ConnectionRow, "business_id" | "location_id" | "price_source" | "price_list_id">,
  localId: string,
): Promise<bigint | null> {
  if (connection.business_id !== businessId) return null;
  const { rows } = await query<{ price: string | null }>(
    `SELECT CASE WHEN $4 = 'list' THEN (
       SELECT e.price::text FROM price_list_entries e
       JOIN price_lists p ON p.id = e.price_list_id AND p.location_id = i.location_id
       WHERE e.item_id = i.id AND e.price_list_id = $5 AND p.currency IN ('IRR', 'IRT')
     ) ELSE s.unit_price::text END AS price
     FROM items i JOIN locations l ON l.id = i.location_id AND l.business_id = $1
     LEFT JOIN item_stock s ON s.item_id = i.id
     WHERE i.id = $2 AND ($3::uuid IS NULL OR i.location_id = $3)
     UNION ALL
     SELECT m.price::text FROM menu_items m
     JOIN locations l ON l.id = m.location_id AND l.business_id = $1
     WHERE m.id = $2 AND ($3::uuid IS NULL OR m.location_id = $3) AND $4 = 'base'`,
    [businessId, localId, connection.location_id, connection.price_source ?? "base", connection.price_list_id ?? null],
  );
  const price = rows[0]?.price;
  return price != null && /^\d+$/.test(price) ? BigInt(price) : null;
}
