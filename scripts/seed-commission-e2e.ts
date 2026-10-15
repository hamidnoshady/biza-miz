/** Isolated browser fixture. Never run against a production database. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import { provisionBusiness } from "../src/lib/business-provisioning";
import { getPool, query, withTenant } from "../src/lib/db";
import { accrueCommissionForLine, upsertCommissionRule } from "../src/lib/commission-service";
import { businessToday } from "../src/lib/business-day-service";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.COMMISSION_E2E_SEED !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Commission E2E fixture requires COMMISSION_E2E_SEED=1 and a loopback disposable database");
  }
  const output = process.argv[2];
  if (!output) throw new Error("Pass an ignored fixture output path");
  const suffix = randomUUID().slice(0, 8);
  const password = randomUUID();
  const ownerEmail = `commission-owner-${suffix}@example.com`;
  const business = await provisionBusiness({ businessName: `Commission E2E ${suffix}`, ownerName: "مالک آزمون",
    email: ownerEmail, password, industry: "cosmetics", seedChartOfAccounts: true, completeSetup: true });
  await withTenant(business.businessId, async () => {
    const hash = await bcrypt.hash(password, 10);
    async function member(name: string, role: string, permissions: object = {}) {
      const email = `commission-${role}-${randomUUID().slice(0, 8)}@example.com`;
      const identity = await query<{ id: string }>(
        "INSERT INTO platform_users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id", [email, hash, name]);
      const user = await query<{ id: string }>(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email, password_hash, permissions)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [business.businessId, identity.rows[0].id, role, name, email, hash, JSON.stringify(permissions)]);
      return { id: user.rows[0].id, email };
    }
    // Calculator deliberately also holds approval: the no-self-approval policy
    // must be enforced by the server, not accidentally by a missing permission.
    const manager = await member("مدیر آزمون", "manager", { granted: ["commission.approve"] });
    const reviewer = await member("بازبین آزمون", "accountant", { granted: ["billing.view"], revoked: ["commission.payout", "commission.reverse"] });
    // The shared shell reads the wallet badge. Explicit read entitlement keeps
    // unrelated shell permission failures distinct from commission denials.
    const accountant = await member("حسابدار آزمون", "accountant", { granted: ["billing.view"] });
    const seller = await member("فروشنده آزمون", "cashier");
    await upsertCommissionRule(business.businessId, { employeeId: seller.id, kind: "percent", basis: "net", value: 5 });
    const client = await getPool().connect();
    let orderId: string;
    try {
      await client.query("BEGIN");
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (location_id, order_number, type, status, opened_by)
         VALUES ($1,1,'retail','open',$2) RETURNING id`, [business.locationId, seller.id]);
      orderId = order.rows[0].id;
      const line = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1,$2,'کالای آزمون',100000,1,'served') RETURNING id`, [business.locationId, orderId]);
      await accrueCommissionForLine(client, { businessId: business.businessId, locationId: business.locationId,
        employeeId: seller.id, sourceType: "order_item", sourceId: line.rows[0].id,
        line: { net: 100000, itemId: randomUUID() }, createdBy: manager.id });
      await client.query("UPDATE orders SET status='completed', closed_at=now(), closed_by=$2, total=100000 WHERE id=$1", [orderId, seller.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    await query(`INSERT INTO settings (business_id, location_id, key, value)
      VALUES ($1,NULL,'business.prefs','{"currencyDisplay":"rial"}'::jsonb)
      ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = settings.value || EXCLUDED.value`, [business.businessId]);
    const fixture = { ...business, manager, reviewer, accountant, seller, password, orderId,
      today: await businessToday(business.businessId) };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(fixture), { mode: 0o600 });
  });
}
main().finally(() => getPool().end()).catch((error) => { console.error(error); process.exitCode = 1; });
