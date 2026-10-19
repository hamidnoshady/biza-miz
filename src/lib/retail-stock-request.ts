import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export class RetailRequestConflict extends Error {
  constructor() { super("idempotency_conflict"); }
}

/** Sort object keys, not arrays: line order and serial order are document data. */
export function canonicalRequestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRequestJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalRequestJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Must run in the caller's stock transaction. INSERT waits for a concurrent
 * first writer; the subsequent SELECT sees its committed result at READ
 * COMMITTED. A rollback removes the reservation too, allowing a safe retry.
 * Uniqueness is tenant + operation + key, with branch bound into the hash.
 */
export async function beginRetailRequest<T>(client: PoolClient, input: {
  businessId: string; locationId: string; operation: "purchase" | "supplier_return";
  idempotencyKey: string; payload: unknown;
}): Promise<T | null> {
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new Error("invalid_idempotency_key");
  }
  const hash = createHash("sha256").update(canonicalRequestJson({ locationId: input.locationId, payload: input.payload })).digest("hex");
  const args = [input.businessId, input.operation, input.idempotencyKey];
  const { rows: inserted } = await client.query(
    `INSERT INTO retail_stock_requests (business_id,operation,idempotency_key,location_id,payload_hash)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING business_id`,
    [...args, input.locationId, hash],
  );
  if (inserted.length) return null;
  const { rows } = await client.query<{ payload_hash: string; result: T | null }>(
    `SELECT payload_hash,result FROM retail_stock_requests
      WHERE business_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE`, args,
  );
  if (!rows[0] || rows[0].payload_hash !== hash) throw new RetailRequestConflict();
  if (rows[0].result === null) throw new Error("incomplete_retail_request");
  return rows[0].result;
}

export async function finishRetailRequest(client: PoolClient, input: {
  businessId: string; operation: "purchase" | "supplier_return"; idempotencyKey: string;
}, result: unknown): Promise<void> {
  await client.query(`UPDATE retail_stock_requests SET result=$4::jsonb
    WHERE business_id=$1 AND operation=$2 AND idempotency_key=$3`,
  [input.businessId, input.operation, input.idempotencyKey, JSON.stringify(result)]);
}
