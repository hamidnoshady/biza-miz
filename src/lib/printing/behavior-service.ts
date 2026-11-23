import type { PoolClient } from "pg";
import { query } from "../db";
import { parsePrintPolicy, type PrintPolicy } from "./behavior";

export async function loadPrintBehavior(
  businessId: string,
  locationId: string,
  client?: Pick<PoolClient, "query">,
): Promise<{ defaults: PrintPolicy; overrides: PrintPolicy; effective: PrintPolicy }> {
  const sql = `SELECT location_id, value FROM settings
    WHERE business_id = $1 AND key = 'printing.behavior' AND (location_id = $2 OR location_id IS NULL)`;
  const params = [businessId, locationId];
  type Row = { location_id: string | null; value: unknown };
  const { rows } = client ? await client.query<Row>(sql, params) : await query<Row>(sql, params);
  const defaults = parsePrintPolicy(rows.find((row) => row.location_id === null)?.value) ?? {};
  const overrides = parsePrintPolicy(rows.find((row) => row.location_id === locationId)?.value) ?? {};
  return { defaults, overrides, effective: { ...defaults, ...overrides } };
}
