/**
 * Issue #824 finding 2: `seedChartOfAccounts` on a chart that is already live.
 *
 * `changeBusinessIndustry` re-runs the seed against a business that has data,
 * archived accounts and an operator's own edits. The seed used to load only
 * `id, code, level` and then insert every missing template child under its
 * parent, whatever the parent's archive state or type. Those tests pin the
 * canonical rules instead: a conflict is reported as a typed `AccountsError`,
 * the caller's transaction rolls back, and no live row is changed or
 * reactivated.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query, withoutTenantScope } from "../src/lib/db";
import { provisionBusiness, seedChartOfAccounts } from "../src/lib/business-provisioning";
import { createAccount, setAccountActive } from "../src/lib/accounts-service";
import type { Industry } from "../src/lib/industries";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

afterAll(async () => {
  await getPool().end().catch(() => {});
});

/** A business with no chart at all, so each test shapes the live chart it needs. */
async function emptyBusiness(name: string): Promise<string> {
  const created = await provisionBusiness({
    businessName: name,
    ownerName: "مالک",
    email: `owner-${randomUUID()}@example.com`,
    password: "correct-horse",
    seedChartOfAccounts: false,
  });
  return created.businessId;
}

/** Runs the seed the way `changeBusinessIndustry` does: one transaction, rolled back on error. */
async function runSeed(businessId: string, industry: Industry = "food_service"): Promise<string[]> {
  return withoutTenantScope("test", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const inserted = await seedChartOfAccounts(client, businessId, industry);
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

type ChartRow = {
  code: string;
  name: string;
  type: string;
  is_active: boolean;
  is_contra: boolean;
  level: string;
  parent_code: string | null;
};

async function chartOf(businessId: string): Promise<ChartRow[]> {
  return withoutTenantScope("test", async () => {
    const { rows } = await query<ChartRow>(
      `SELECT a.code, a.name, a.type::text AS type, a.is_active, a.is_contra,
              a.level::text AS level, p.code AS parent_code
         FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
        WHERE a.business_id = $1 ORDER BY a.code`,
      [businessId],
    );
    return rows;
  });
}

describe("issue #824 finding 2: seeding a live chart", () => {
  it("refuses a template child whose live parent is archived, with a typed conflict and nothing written", async () => {
    const businessId = await emptyBusiness("سرپرست بایگانی‌شده");
    const root = await withoutTenantScope("test", () =>
      createAccount({ businessId, code: "1000", name: "دارایی‌های بایگانی", type: "asset" }),
    );
    await withoutTenantScope("test", () => setAccountActive(businessId, root.id, false));
    const before = await chartOf(businessId);

    await expect(runSeed(businessId)).rejects.toThrow("parent_archived");

    // Atomic: the refusal leaves the chart exactly as it was, the archived
    // parent still archived and every other template root not inserted either.
    expect(await chartOf(businessId)).toEqual(before);
  }, 60_000);

  it("refuses a template child whose live parent has a different accounting type, with nothing written", async () => {
    const businessId = await emptyBusiness("نوع ناسازگار");
    // The template's 1000 is an asset; the operator's live 1000 is a liability.
    await withoutTenantScope("test", () =>
      createAccount({ businessId, code: "1000", name: "بدهی به‌جای دارایی", type: "liability" }),
    );
    const before = await chartOf(businessId);

    await expect(runSeed(businessId)).rejects.toThrow("parent_type_mismatch");
    expect(await chartOf(businessId)).toEqual(before);
  }, 60_000);

  it("adds what is missing under an active parent and never reactivates or renames an archived live row", async () => {
    const businessId = await emptyBusiness("حفظ ردیف‌ها");
    const parent = await withoutTenantScope("test", () =>
      createAccount({ businessId, code: "1000", name: "دارایی‌های من", type: "asset" }),
    );
    const archivedLeaf = await withoutTenantScope("test", () =>
      createAccount({ businessId, code: "1130", name: "تنخواه قدیمی", type: "asset", parentId: parent.id }),
    );
    await withoutTenantScope("test", () => setAccountActive(businessId, archivedLeaf.id, false));

    const inserted = await runSeed(businessId);

    expect(inserted).not.toContain("1130");
    expect(inserted).toContain("1110");
    const rows = await chartOf(businessId);
    expect(rows.find((r) => r.code === "1130")).toMatchObject({
      name: "تنخواه قدیمی",
      type: "asset",
      is_active: false,
      parent_code: "1000",
    });
    expect(rows.find((r) => r.code === "1000")).toMatchObject({ name: "دارایی‌های من", is_active: true });
    // A repeat run is a no-op: nothing new, nothing reactivated.
    const again = await runSeed(businessId);
    expect(again).toEqual([]);
    expect((await chartOf(businessId)).find((r) => r.code === "1130")?.is_active).toBe(false);
  }, 60_000);
});
