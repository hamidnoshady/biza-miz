/**
 * What every DB-touching payroll module shares: one way to run a query on the
 * pool *or* on a transaction's connection, one way to open a transaction, and
 * the lock that serialises payroll's read-then-write sections.
 *
 * Its own module so the payroll service, the advances service and the payment
 * account resolver cannot drift apart on any of them.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import type { RialText } from "./inventory-exact";

/** `query()` or a transaction's client, behind one signature, so a read can serve both. */
export type Runner = <T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

export const poolRunner: Runner = (text, params) => query(text, params) as never;

export const clientRunner =
  (client: PoolClient): Runner =>
  (text, params) =>
    client.query(text, params as never) as never;

/** One transaction on its own connection (the tenant scope is stamped on it by the pool). */
export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one that explains what went wrong.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serialises every payroll mutation that reads state it is about to change — an
 * accrual (duplicate checks, the advance balances it recovers, the commission
 * it claims), a void, and an advance void — one at a time per business. A
 * transaction-scoped advisory lock: released at COMMIT or ROLLBACK, never leaks.
 */
export async function lockPayroll(client: PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll:${businessId}`]);
}

/** Integer text from a non-negative bigint — the one way an amount leaves a payroll module. */
export const asRial = (value: bigint): RialText => value.toString() as RialText;
