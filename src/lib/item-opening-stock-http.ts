/**
 * Shared HTTP plumbing for the opening-stock routes (GH #1567 F2): the trade
 * gate, the transaction wrapper and the error mapping, so each route file is
 * only its permission and its call.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { isRetailCatalogueIndustry } from "./industries";
import { OpeningStockError } from "./item-opening-stock-service";
import { MissingLedgerAccountError } from "./ledger-service";

/** Opening stock is an items-model (retail catalogue) document; F&B keeps its own cutover. */
export async function openingStockIndustryError(businessId: string): Promise<NextResponse | null> {
  const industry = await getBusinessIndustry(businessId);
  if (!isRetailCatalogueIndustry(industry)) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }
  return null;
}

export async function withOpeningStockTransaction(
  fn: (client: PoolClient) => Promise<NextResponse>,
): Promise<NextResponse> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const response = await fn(client);
    await client.query("COMMIT");
    return response;
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof OpeningStockError) {
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

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
