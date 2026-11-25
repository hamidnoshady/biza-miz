/**
 * Shared HTTP plumbing for the items-model NRV write-down routes (GH #1567
 * F3): the trade gate, the transaction wrapper and the error mapping.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { isRetailCatalogueIndustry } from "./industries";
import { ItemWriteDownError } from "./item-nrv-write-down-service";
import { MissingLedgerAccountError } from "./ledger-service";

/** Items-model write-downs; F&B keeps `/api/inventory/write-downs` (allowance). */
export async function itemWriteDownIndustryError(businessId: string): Promise<NextResponse | null> {
  if (!isRetailCatalogueIndustry(await getBusinessIndustry(businessId))) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }
  return null;
}

export async function withItemWriteDownClient(
  fn: (client: PoolClient) => Promise<NextResponse>,
  options: { transaction: boolean },
): Promise<NextResponse> {
  const client = await getPool().connect();
  try {
    if (options.transaction) await client.query("BEGIN");
    const response = await fn(client);
    if (options.transaction) await client.query("COMMIT");
    return response;
  } catch (err) {
    if (options.transaction) await client.query("ROLLBACK");
    if (err instanceof ItemWriteDownError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "account_missing", message: err.message }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function readWriteDownBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
