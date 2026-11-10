import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { todayIsoDate, todayJalali } from "../src/lib/jalali";

const originalUrl = process.env.DATABASE_URL;
if (!originalUrl) throw new Error("DATABASE_URL is required for database integration tests");
const databaseName = `pos_petty_${randomUUID().replaceAll("-", "")}`;
const maintenanceUrl = new URL(originalUrl);
maintenanceUrl.pathname = "/postgres";
const databaseUrl = new URL(originalUrl);
databaseUrl.pathname = `/${databaseName}`;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let petty: typeof import("../src/lib/petty-cash-service");
let expenses: typeof import("../src/lib/expense-service");
let transfers: typeof import("../src/lib/financial-transfers-service");
let fiscal: typeof import("../src/lib/fiscal-periods-service");

beforeAll(async () => {
  const maintenance = new Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: databaseUrl.href, quiet: true });
  process.env.DATABASE_URL = databaseUrl.href;
  dbLib = await import("../src/lib/db");
  petty = await import("../src/lib/petty-cash-service");
  expenses = await import("../src/lib/expense-service");
  transfers = await import("../src/lib/financial-transfers-service");
  fiscal = await import("../src/lib/fiscal-periods-service");
  db = new Client({ connectionString: databaseUrl.href });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = originalUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function insertId(sql: string, params: unknown[]): Promise<string> {
  return (await db.query<{ id: string }>(sql, params)).rows[0].id;
}

describe("managed petty cash", () => {
  it("rolls back a fiscal refusal and posts the complete workflow exactly once", async () => {
    const businessId = await insertId("INSERT INTO businesses (name, slug) VALUES ('Petty', 'petty-test') RETURNING id", []);
    const branchId = await insertId("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [businessId]);
    const otherBranchId = await insertId("INSERT INTO locations (business_id, name) VALUES ($1, 'Other') RETURNING id", [businessId]);
    const ownerId = await insertId(
      "INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'owner', 'Owner', 'x') RETURNING id", [businessId, branchId],
    );
    const custodianId = await insertId(
      "INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'cashier', 'Custodian', 'x') RETURNING id", [businessId, branchId],
    );
    await db.query("INSERT INTO employees (business_id, id) VALUES ($1, $2)", [businessId, custodianId]);
    const bankGl = await insertId("INSERT INTO accounts (business_id, code, name, type) VALUES ($1,'1110','Bank','asset') RETURNING id", [businessId]);
    const pettyGl = await insertId("INSERT INTO accounts (business_id, code, name, type) VALUES ($1,'1130','Petty','asset') RETURNING id", [businessId]);
    const categoryAccountId = await insertId("INSERT INTO accounts (business_id, code, name, type) VALUES ($1,'6100','Costs','expense') RETURNING id", [businessId]);
    const fundingAccountId = await insertId(
      "INSERT INTO financial_accounts (business_id, kind, name, gl_account_id, currency_code) VALUES ($1,'bank','Bank',$2,'IRR') RETURNING id", [businessId, bankGl],
    );
    const accountId = await insertId(
      "INSERT INTO financial_accounts (business_id, location_id, kind, name, gl_account_id, currency_code) VALUES ($1,$2,'petty_cash','Petty',$3,'IRR') RETURNING id", [businessId, branchId, pettyGl],
    );
    const receiptAssetId = await insertId(
      `INSERT INTO media_assets (business_id, created_by, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1,$2,'image','receipt.png','image/png',256,'test-receipt',$3) RETURNING id`, [businessId, custodianId, "0".repeat(64)],
    );
    const manager = { businessId, actorId: ownerId, role: "owner", locationIds: [branchId], canManage: true, canApprove: true, canViewLedger: true };
    const custodian = { ...manager, actorId: custodianId, role: "cashier", canManage: false, canApprove: false, canViewLedger: false };
    const date = todayIsoDate();
    const yearNumber = todayJalali().jy;

    await dbLib.withTenant(businessId, async () => {
      const config = { accountId, fundingAccountId, locationId: branchId, custodianId, ceiling: "5000", policy: "fixed", categoryAccountIds: [categoryAccountId], approvalRoles: ["owner"] };
      const fund = await petty.configurePettyCashFund(manager, config);
      expect(await petty.configurePettyCashFund(manager, config)).toMatchObject({ id: fund.id });
      expect(await petty.listPettyCashFunds({ ...manager, locationIds: [otherBranchId] })).toEqual([]);
      expect(await petty.listPettyCashFunds({ ...custodian, actorId: ownerId })).toEqual([]);
      expect(await petty.listPettyCashFunds(custodian)).toEqual([expect.objectContaining({ id: fund.id, canSubmit: true })]);

      await fiscal.createFiscalYear(businessId, yearNumber);
      const [year] = await fiscal.listFiscalYears(businessId);
      const period = (await fiscal.listPeriods(businessId, year.id)).find((row) => row.startsOn <= date && row.endsOn >= date)!;
      await fiscal.setPeriodStatus(businessId, period.id, "soft_closed", ownerId);
      await fiscal.setPeriodStatus(businessId, period.id, "locked", ownerId);
      const fundBody = { action: "fund", amount: "5000", businessDate: date, note: "Initial" };
      await expect(petty.createPettyCashOperation(manager, fund.id, fundBody, "fund")).rejects.toThrow("fiscal_period_locked");
      expect(await petty.listPettyCashFunds(manager)).toEqual([expect.objectContaining({ fundedAt: null, balance: "0" })]);
      await fiscal.setPeriodStatus(businessId, period.id, "open", ownerId);

      const [funding, retried] = await Promise.all([
        petty.createPettyCashOperation(manager, fund.id, fundBody, "fund"),
        petty.createPettyCashOperation(manager, fund.id, fundBody, "fund"),
      ]);
      expect(retried).toMatchObject({ id: funding.id, transferId: funding.transferId });
      await expect(petty.createPettyCashOperation(manager, fund.id, { ...fundBody, note: "Changed" }, "fund")).rejects.toThrow("idempotency_conflict");

      await expect(transfers.createFinancialTransfer({
        businessId, actorId: ownerId, locationId: branchId,
        input: { transferDate: date, amount: "10", sourceAccountId: fundingAccountId, destinationAccountId: accountId },
      })).rejects.toThrow("petty_cash_workflow_required");
      await expect(expenses.recordExpense({
        businessId, locationId: branchId, accountId: categoryAccountId, paymentAccountId: pettyGl,
        amount: 10, expenseDate: date, memo: "Bypass", createdBy: ownerId,
      })).rejects.toThrow("petty_cash_workflow_required");

      const expense = await petty.createPettyCashOperation(custodian, fund.id, {
        action: "submit", amount: "1000", businessDate: date, note: "Receipt", categoryAccountId, receiptAssetId,
      }, "receipt");
      expect(expense).toMatchObject({ status: "pending", expenseId: null });
      expect(await petty.canReadPettyCashReceipt(manager, fund.id, receiptAssetId)).toBe(true);
      expect(await petty.canReadPettyCashReceipt({ ...manager, locationIds: [otherBranchId] }, fund.id, receiptAssetId)).toBe(false);
      const close = { action: "close", amount: "5000", businessDate: date, note: "Final count" };
      await expect(petty.createPettyCashOperation(manager, fund.id, close, "close")).rejects.toThrow("petty_cash_pending_expenses");
      const approval = { action: "approve", businessDate: date, operationId: expense.id };
      await expect(petty.decidePettyCashExpense({ ...manager, actorId: custodianId }, fund.id, approval, "approval")).rejects.toThrow("forbidden");
      const approved = await petty.decidePettyCashExpense(manager, fund.id, approval, "approval");
      expect(approved.expenseId).toBeTruthy();
      expect(await petty.decidePettyCashExpense(manager, fund.id, approval, "approval")).toMatchObject({ expenseId: approved.expenseId, status: "approved" });

      const count = await petty.createPettyCashOperation(custodian, fund.id, { ...close, action: "reconcile", amount: "3900" }, "count");
      expect(count).toMatchObject({ status: "discrepancy", ledgerBalance: "4000" });
      const replenishment = await petty.createPettyCashOperation(manager, fund.id, { ...fundBody, action: "replenish", amount: "1000" }, "replenish");
      expect(replenishment.transferId).toBeTruthy();
      const closed = await petty.createPettyCashOperation(manager, fund.id, close, "close");
      expect(closed.transferId).toBeTruthy();
      expect(await petty.listPettyCashFunds(manager)).toEqual([expect.objectContaining({ balance: "0", closedAt: expect.any(String) })]);

      const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
        `SELECT jl.account_id, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
           FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.business_id = $1 GROUP BY jl.account_id`, [businessId],
      );
      expect(rows).toEqual(expect.arrayContaining([
        { account_id: pettyGl, debit: "6000", credit: "6000" },
        { account_id: bankGl, debit: "5000", credit: "6000" },
        { account_id: categoryAccountId, debit: "1000", credit: "0" },
      ]));
    }, { locationId: branchId, userId: ownerId });
  }, 30_000);
});
