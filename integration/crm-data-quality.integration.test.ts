/**
 * The data-quality workspace's rules, against real PostgreSQL.
 *
 * It runs in its own scratch database because a rule like «مشتری بدون راه
 * تماس» can only be asserted exactly when the whole table is known — and each
 * rule gets its **own business**, so a fixture created for one rule cannot
 * change another's count. That also gives every assertion a tenant-isolation
 * half for free: the gap created in business A never appears in business B.
 *
 * What is pinned:
 *
 *  1. **Each rule finds the gap and nothing else.** A customer with a phone, a
 *     deal that *has* a customer, a lead touched yesterday, a ticket that
 *     belongs to somebody — none may appear. A hygiene report that cries wolf is
 *     one nobody reads.
 *  2. **Merged-away rows are not gaps.** The row absorbed by a merge is history;
 *     the *survivor* is still a customer, and is still a gap if nobody can reach
 *     them.
 *  3. **Counts are real, previews are capped** — and the oldest gap is the one
 *     shown, because it has been wrong the longest.
 *  4. **A legacy name with no id is not «بدون مسئول».** It has an owner written
 *     down; the reassignment list is where it belongs.
 *  5. **Every issue describes itself and links somewhere that acts on it.**
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let quality: typeof import("../src/lib/crm-data-quality");
let database: typeof import("../src/lib/db");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/** A business per rule, so each rule's table is exactly what its test created. */
async function makeBusiness(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ($1, $2, 'food_service') RETURNING id`,
    [name, `dq-${randomUUID().slice(0, 8)}`],
  );
  const businessId = rows[0].id;
  await db.query(`INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی')`, [businessId]);
  return businessId;
}

async function makeParty(
  businessId: string,
  input: {
    name: string;
    phone?: string | null;
    email?: string | null;
    mergedInto?: string | null;
    active?: boolean;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles, phone, email, merged_into_id, is_active)
     VALUES ($1, $2, ARRAY['customer']::text[], $3, $4, $5, $6) RETURNING id`,
    [
      businessId,
      input.name,
      input.phone ?? null,
      input.email ?? null,
      input.mergedInto ?? null,
      input.active ?? true,
    ],
  );
  return rows[0].id;
}

async function makeDeal(
  businessId: string,
  input: { title: string; customerId?: string | null; closed?: boolean; ownerUserId?: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_deals (business_id, title, value_rial, customer_id, closed_at, owner_user_id)
     VALUES ($1, $2, 1000000, $3, $4, $5) RETURNING id`,
    [
      businessId,
      input.title,
      input.customerId ?? null,
      input.closed ? new Date().toISOString() : null,
      input.ownerUserId ?? null,
    ],
  );
  return rows[0].id;
}

async function makeLead(
  businessId: string,
  input: { name: string; daysAgo: number; status?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_leads (business_id, name, status, updated_at)
     VALUES ($1, $2, $3, now() - ($4::int * interval '1 day')) RETURNING id`,
    [businessId, input.name, input.status ?? "new", input.daysAgo],
  );
  return rows[0].id;
}

async function makeCase(
  businessId: string,
  input: {
    subject: string;
    assigneeUserId?: string | null;
    assignedTo?: string;
    status?: string;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_cases
       (business_id, subject, status, priority, assignee_user_id, assigned_to, case_number)
     VALUES ($1, $2, $3, 'normal', $4, $5, $6) RETURNING id`,
    [
      businessId,
      input.subject,
      input.status ?? "open",
      input.assigneeUserId ?? null,
      input.assignedTo ?? "",
      Math.floor(Math.random() * 1_000_000),
    ],
  );
  return rows[0].id;
}

async function makeMember(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
    [businessId, name, `dq-${randomUUID().slice(0, 8)}@example.test`],
  );
  return rows[0].id;
}

type Groups = Awaited<ReturnType<typeof quality.crmDataQuality>>;

const groupOf = (groups: Groups, key: string) => groups.find((group) => group.key === key)!;
const idsOf = (groups: Groups, key: string) => groupOf(groups, key).items.map((item) => item.id);

beforeAll(async () => {
  databaseName = `pos_dq_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  quality = await import("../src/lib/crm-data-quality");
  database = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  // The rules read through the app's pooled connection; closing it before the
  // drop keeps Postgres from logging a killed connection for every pool slot.
  await database?.closeDatabasePool();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("the data-quality rules", () => {
  it("names a customer with no phone and no email, and only that customer", async () => {
    const businessId = await makeBusiness("کیفیت — تماس");
    const survivor = await makeParty(businessId, { name: "بازماندهٔ ادغام" });
    const unreachable = await makeParty(businessId, { name: "بی‌راه‌تماس" });
    const reachable = await makeParty(businessId, { name: "دارای شماره", phone: "09120000000" });
    const byEmail = await makeParty(businessId, { name: "دارای ایمیل", email: "a@example.test" });
    // The row absorbed by the merge: history, not a gap.
    const absorbed = await makeParty(businessId, { name: "جذب‌شده", mergedInto: survivor });
    const inactive = await makeParty(businessId, { name: "غیرفعال", active: false });
    // Another business's unreachable customer, which must not leak in.
    const otherBusiness = await makeBusiness("کیفیت — دیگری");
    const foreign = await makeParty(otherBusiness, { name: "بی‌راه‌تماس بیگانه" });

    const groups = await quality.crmDataQuality(businessId);
    const ids = idsOf(groups, "missing_contact");
    expect(ids).toContain(unreachable);
    // The *survivor* of a merge is still a customer, and still unreachable.
    expect(ids).toContain(survivor);
    expect(ids).not.toContain(absorbed);
    expect(ids).not.toContain(reachable);
    expect(ids).not.toContain(byEmail);
    expect(ids).not.toContain(inactive);
    expect(ids).not.toContain(foreign);
    expect(groupOf(groups, "missing_contact").count).toBe(2);
  });

  it("caps the preview at five, reports the real count, and starts with the oldest", async () => {
    const businessId = await makeBusiness("کیفیت — پیش‌نمایش");
    const oldest = await makeParty(businessId, { name: "قدیمی‌ترین" });
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await makeParty(businessId, { name: `بی‌تماس ${index}` }));
    }

    const group = groupOf(await quality.crmDataQuality(businessId), "missing_contact");
    expect(group.count).toBe(6);
    expect(group.items).toHaveLength(quality.PREVIEW_LIMIT);
    expect(group.items[0].id).toBe(oldest);
    // The sixth is counted, not shown — the number and the list come from one
    // statement, so the screen can honestly say «۱ مورد دیگر».
    expect(created.filter((id) => group.items.map((item) => item.id).includes(id))).toHaveLength(4);
  });

  it("names an open deal with no customer, and leaves linked and closed deals alone", async () => {
    const businessId = await makeBusiness("کیفیت — معامله");
    const customer = await makeParty(businessId, { name: "مشتری معامله", phone: "09121111111" });
    const member = await makeMember(businessId, "مسئول معامله");
    const orphan = await makeDeal(businessId, { title: "فرصت بی‌مشتری" });
    const linked = await makeDeal(businessId, {
      title: "فرصت بامشتری",
      customerId: customer,
      ownerUserId: member,
    });
    const closedOrphan = await makeDeal(businessId, { title: "فرصت بسته", closed: true });

    const groups = await quality.crmDataQuality(businessId);
    const ids = idsOf(groups, "unlinked_deal");
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(linked);
    expect(ids).not.toContain(closedOrphan);
    expect(groupOf(groups, "unlinked_deal").count).toBe(1);
  });

  it("names a lead nobody has touched, and leaves the fresh and converted ones alone", async () => {
    const businessId = await makeBusiness("کیفیت — سرنخ");
    const stale = await makeLead(businessId, {
      name: "سرنخ فراموش‌شده",
      daysAgo: quality.STALE_LEAD_DAYS + 6,
    });
    const fresh = await makeLead(businessId, { name: "سرنخ تازه", daysAgo: 1 });
    const converted = await makeLead(businessId, {
      name: "سرنخ تبدیل‌شده",
      daysAgo: quality.STALE_LEAD_DAYS + 30,
      status: "converted",
    });

    const groups = await quality.crmDataQuality(businessId);
    const ids = idsOf(groups, "stale_lead");
    expect(ids).toContain(stale);
    expect(ids).not.toContain(fresh);
    // A converted lead is history — not «untouched», done.
    expect(ids).not.toContain(converted);
    expect(groupOf(groups, "stale_lead").count).toBe(1);
  });

  it("names work with neither a member nor a name, and keeps legacy names out of it", async () => {
    const businessId = await makeBusiness("کیفیت — مسئول");
    const member = await makeMember(businessId, "صاحب کار");
    const orphanCase = await makeCase(businessId, { subject: "تیکت بی‌مسئول" });
    const assignedCase = await makeCase(businessId, {
      subject: "تیکت بامسئول",
      assigneeUserId: member,
    });
    // A pre-picker row: a name and no id. It has an owner written down, so it
    // belongs to the reassignment list, not to «بدون مسئول».
    const namedCase = await makeCase(businessId, { subject: "تیکت نام‌دار", assignedTo: "آقای قدیمی" });
    const resolvedCase = await makeCase(businessId, { subject: "تیکت بسته", status: "resolved" });
    const orphanDeal = await makeDeal(businessId, { title: "فرصت بی‌مسئول" });
    const assignedDeal = await makeDeal(businessId, { title: "فرصت بامسئول", ownerUserId: member });

    const groups = await quality.crmDataQuality(businessId);
    const ids = idsOf(groups, "unowned_work");
    expect(ids).toContain(orphanCase);
    expect(ids).toContain(orphanDeal);
    expect(ids).not.toContain(assignedCase);
    expect(ids).not.toContain(namedCase);
    expect(ids).not.toContain(resolvedCase);
    expect(ids).not.toContain(assignedDeal);
    expect(groupOf(groups, "unowned_work").count).toBe(2);
  });

  it("describes every rule and links it somewhere that acts on it", async () => {
    const businessId = await makeBusiness("کیفیت — توصیف");
    await makeParty(businessId, { name: "بی‌تماس" });
    const groups = await quality.crmDataQuality(businessId);

    expect(groups.map((group) => group.key).sort()).toEqual(
      [...quality.CRM_DATA_QUALITY_KINDS].sort(),
    );
    for (const group of groups) {
      expect(group.label.trim().length).toBeGreaterThan(0);
      expect(group.why.trim().length).toBeGreaterThan(0);
      expect(group.action.trim().length).toBeGreaterThan(0);
      expect(group.section.trim().length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.href.startsWith("/crm/")).toBe(true);
        expect(item.subtitle.trim().length).toBeGreaterThan(0);
        expect(item.title.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
