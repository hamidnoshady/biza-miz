/**
 * Issue #902 §5 acceptance, against a real database.
 *
 * What this file proves, in the issue's own terms:
 *   1. "Allow Superadmin enable/disable catalog entries by business type /
 *      channel / plan" — an entry targeted at one trade or one plan is offered
 *      to exactly those businesses, and a disabled entry is offered to none.
 *   2. A business's copy comes from the library, carries its origin and version,
 *      and adding the same entry twice does not create a second draft.
 *   3. "Updating master template must support safe versioned rollout and
 *      reapproval without breaking active sends" — saving a new body bumps the
 *      version and leaves the existing copy on the text it was approved with.
 *   4. A business cannot reach an entry it was not offered, even by id.
 *   5. The library is platform-only: a tenant-scoped connection reads nothing
 *      from it, and the tenant-facing shape carries no provider identity.
 *
 * No network call is made and no provider client is constructed: the library is
 * data, and rendering is pure (`template-variables.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
/** An unprivileged role, so the RLS assertion is not bypassed by `pos`. */
let probeRole: string;

let dbLib: typeof import("../src/lib/db");
let master: typeof import("../src/lib/kavenegar/master-template-service");
let templates: typeof import("../src/lib/kavenegar/template-service");

const jewelry = { businessId: "", slug: "" };
const grocery = { businessId: "", slug: "" };
let planKey = "";
let otherPlanKey = "";

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

async function seedBusiness(input: {
  name: string;
  industry: string;
  plan: string;
}): Promise<{ businessId: string; slug: string }> {
  const slug = `${input.name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry, plan) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.name, slug, input.industry, input.plan],
  );
  return { businessId: rows[0]!.id, slug };
}

beforeAll(async () => {
  databaseName = `pos_kavenegar_lib_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  master = await import("../src/lib/kavenegar/master-template-service");
  templates = await import("../src/lib/kavenegar/template-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  probeRole = `kvl_probe_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await db.query(`CREATE ROLE ${probeRole} NOLOGIN`);
  await db.query(`GRANT SELECT ON kavenegar_master_templates TO ${probeRole}`);

  const plans = await db.query<{ key: string }>(
    `SELECT key FROM billing_plans WHERE status = 'active' ORDER BY sort_order LIMIT 2`,
  );
  planKey = plans.rows[0]?.key ?? "free";
  otherPlanKey = plans.rows[1]?.key ?? planKey;
}, 180_000);

afterAll(async () => {
  if (probeRole) {
    const probe = new Client({ connectionString: urlFor(databaseName) });
    await probe.connect();
    try {
      await probe.query(`DROP OWNED BY ${probeRole}`);
    } finally {
      await probe.end();
    }
    const admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
    } finally {
      await admin.end();
    }
  }
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM kavenegar_lookup_templates");
  await db.query("DELETE FROM businesses");
  // Restore the seeded library, since a test may have edited it.
  await db.query("DELETE FROM kavenegar_master_templates WHERE key LIKE 'test_%'");
  await db.query("UPDATE kavenegar_master_templates SET enabled = true, industries = '{}', plans = '{}'");
  Object.assign(
    jewelry,
    await seedBusiness({ name: "Zarringar", industry: "jewelry", plan: planKey }),
  );
  Object.assign(
    grocery,
    await seedBusiness({ name: "Kharid", industry: "food_service", plan: otherPlanKey }),
  );
});

async function addLibraryEntry(overrides: Partial<Parameters<typeof master.saveMasterTemplate>[0]> = {}) {
  return master.saveMasterTemplate({
    key: overrides.key ?? `test_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    title: "آمادهٔ تحویل سفارش",
    body: "%token عزیز، سفارش شما آماده است.",
    purpose: "transactional",
    variables: ["customer_name"],
    actorId: null,
    ...overrides,
  });
}

describe("the seeded library", () => {
  it("ships the three messages every business needs, offered to everyone", async () => {
    const library = await master.listMasterTemplates();
    const keys = library.map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["login_code", "order_ready", "payment_received"]));

    const login = library.find((row) => row.key === "login_code")!;
    expect(login).toMatchObject({
      purpose: "verification",
      variables: ["code"],
      enabled: true,
      version: 1,
      industries: [],
      plans: [],
    });
    // The body the provider would approve, and a sample the console can show.
    expect(login.body).toContain("%token");
  });

  it("offers the untargeted entries to a business of any trade and plan", async () => {
    const offered = await master.masterTemplatesForBusiness(jewelry.businessId);
    expect(offered.map((row) => row.key)).toEqual(
      expect.arrayContaining(["login_code", "order_ready", "payment_received"]),
    );
  });
});

describe("targeting: business type and plan", () => {
  it("offers a trade-targeted entry only to that trade", async () => {
    const entry = await addLibraryEntry({ industries: ["jewelry"] });

    const forJewelry = await master.masterTemplatesForBusiness(jewelry.businessId);
    const forGrocery = await master.masterTemplatesForBusiness(grocery.businessId);

    expect(forJewelry.some((row) => row.id === entry.id)).toBe(true);
    expect(forGrocery.some((row) => row.id === entry.id)).toBe(false);
  });

  it("offers a plan-targeted entry only to businesses on that plan", async () => {
    // A message whose cost the plan is meant to carry, e.g. campaign receipts on
    // the upper plan only.
    const entry = await addLibraryEntry({ plans: [planKey] });

    const onPlan = await master.masterTemplatesForBusiness(jewelry.businessId);
    expect(onPlan.some((row) => row.id === entry.id)).toBe(true);
    if (planKey !== otherPlanKey) {
      const offPlan = await master.masterTemplatesForBusiness(grocery.businessId);
      expect(offPlan.some((row) => row.id === entry.id)).toBe(false);
    }
  });

  it("offers nothing that is disabled, without deleting the businesses that already have it", async () => {
    const entry = await addLibraryEntry();
    await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    await master.setMasterTemplateEnabled({ id: entry.id, enabled: false, actorId: null });

    const offered = await master.masterTemplatesForBusiness(jewelry.businessId);
    expect(offered.some((row) => row.id === entry.id)).toBe(false);
    // The copy survives: disabling withdraws an offer, it does not reach into a
    // business's approved catalog.
    const copies = await db.query(
      `SELECT id, state FROM kavenegar_lookup_templates WHERE master_template_id = $1`,
      [entry.id],
    );
    expect(copies.rowCount).toBe(1);
    expect(copies.rows[0].state).toBe("draft");
  });

  it("is not a version bump: enabling/disabling changes no message", async () => {
    const entry = await addLibraryEntry();
    const disabled = await master.setMasterTemplateEnabled({ id: entry.id, enabled: false, actorId: null });
    expect(disabled.version).toBe(entry.version);

    // Re-saving the SAME text with a different audience is also not a version.
    const retargeted = await master.saveMasterTemplate({
      key: entry.key,
      title: entry.title,
      body: entry.body,
      purpose: entry.purpose,
      variables: entry.variables,
      industries: ["watch"],
      enabled: true,
      actorId: null,
    });
    expect(retargeted.version).toBe(entry.version);
    expect(retargeted.industries).toEqual(["watch"]);
    expect(retargeted.enabled).toBe(true);
  });
});

describe("instantiation: a business copy with a known origin", () => {
  it("creates one draft carrying the library body and version", async () => {
    const entry = await addLibraryEntry();
    const result = await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    expect(result.created).toBe(true);
    expect(result.template).toMatchObject({
      business_id: jewelry.businessId,
      title: entry.title,
      body: entry.body,
      purpose: entry.purpose,
      state: "draft",
      master_template_id: entry.id,
      master_version: entry.version,
    });

    const { rows } = await db.query(
      `SELECT master_template_id, master_version FROM kavenegar_lookup_templates WHERE id = $1`,
      [result.template.id],
    );
    expect(rows[0]).toMatchObject({
      master_template_id: entry.id,
      master_version: entry.version,
    });
  });

  it("is idempotent: adding the same entry twice reuses the draft", async () => {
    const entry = await addLibraryEntry();
    const first = await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });
    const second = await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    expect(second.created).toBe(false);
    expect(second.template.id).toBe(first.template.id);
    const count = await db.query(
      `SELECT count(*)::int AS n FROM kavenegar_lookup_templates WHERE business_id = $1`,
      [jewelry.businessId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("refuses an entry targeted at another trade, even when asked for by id", async () => {
    const entry = await addLibraryEntry({ industries: ["jewelry"] });
    await expect(
      master.instantiateMasterTemplate({
        businessId: grocery.businessId,
        masterTemplateId: entry.id,
      }),
    ).rejects.toThrow(/master_template_not_offered/);
  });

  it("refuses a disabled entry", async () => {
    const entry = await addLibraryEntry({ enabled: false });
    await expect(
      master.instantiateMasterTemplate({
        businessId: jewelry.businessId,
        masterTemplateId: entry.id,
      }),
    ).rejects.toThrow(/master_template_disabled/);
  });

  it("refuses an entry that does not exist", async () => {
    await expect(
      master.instantiateMasterTemplate({
        businessId: jewelry.businessId,
        masterTemplateId: randomUUID(),
      }),
    ).rejects.toThrow(/master_template_not_found/);
  });
});

describe("versioned rollout without breaking an approved send", () => {
  it("bumps the version and leaves the existing copy on its own text", async () => {
    const entry = await addLibraryEntry();
    const copy = await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    const next = await master.saveMasterTemplate({
      key: entry.key,
      title: entry.title,
      body: "%token عزیز، سفارش شما در شعبه آماده است.",
      purpose: entry.purpose,
      variables: entry.variables,
      actorId: null,
    });

    expect(next.version).toBe(entry.version + 1);

    // The business keeps sending the message it was approved for; the new text
    // is only reachable by instantiating again (which produces a new draft,
    // because the derived provider name follows the body).
    const { rows } = await db.query<{ body: string; master_version: number }>(
      `SELECT body, master_version FROM kavenegar_lookup_templates WHERE id = $1`,
      [copy.template.id],
    );
    expect(rows[0]?.body).toBe(entry.body);
    expect(rows[0]?.master_version).toBe(entry.version);
  });

  it("keeps the library lineage when a business revises its copy", async () => {
    const entry = await addLibraryEntry();
    const copy = await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    // Approved, then reworded by the tenant: the revision flow creates a
    // successor, and that successor must still know where it came from.
    await db.query(
      `UPDATE kavenegar_lookup_templates SET state = 'approved', decided_at = now() WHERE id = $1`,
      [copy.template.id],
    );
    const revised = await dbLib.withTenant(jewelry.businessId, () =>
      templates.reviseLookupTemplate({
        businessId: jewelry.businessId,
        templateId: copy.template.id,
        title: entry.title,
        body: "%token عزیز، سفارش شما با پیک ارسال شد.",
      }),
    );

    expect(revised.created).toBe(true);
    expect(revised.template).toMatchObject({
      master_template_id: entry.id,
      master_version: entry.version,
      supersedes_id: copy.template.id,
    });
  });

  it("refuses to save a message its own renderer could not fill", async () => {
    await expect(
      addLibraryEntry({ body: "%token عزیز", variables: [] }),
    ).rejects.toThrow(/variables_mismatch/);
    await expect(
      addLibraryEntry({ body: "%token2 عزیز", variables: ["customer_name"] }),
    ).rejects.toThrow(/token_slot_gap/);
    await expect(
      addLibraryEntry({ body: "سفارش شما آماده است.", variables: ["customer_name"] }),
    ).rejects.toThrow(/body_missing_token/);
  });
});

describe("the library is platform-only", () => {
  it("is unreadable from a business-scoped connection", async () => {
    await db.query(`GRANT USAGE ON SCHEMA public TO ${probeRole}`);

    // Same session settings a tenant request carries (`app.business_id`), but
    // the role is not the owner: FORCE RLS applies, and there is no tenant
    // policy to match.
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM kavenegar_master_templates`,
    );
    expect(rows[0].count).toBeGreaterThan(0);

    const probe = new Client({ connectionString: urlFor(databaseName) });
    await probe.connect();
    try {
      await probe.query(`SET ROLE ${probeRole}`);
      await probe.query(`SELECT set_config('app.business_id', $1, false)`, [jewelry.businessId]);
      const seen = await probe.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM kavenegar_master_templates`,
      );
      expect(seen.rows[0].count).toBe(0);
    } finally {
      await probe.end();
    }
  });

  it("gives the tenant a first-party shape with no provider identity", async () => {
    const entry = await addLibraryEntry();
    await master.instantiateMasterTemplate({
      businessId: jewelry.businessId,
      masterTemplateId: entry.id,
    });

    const library = await master.tenantTemplateLibrary(jewelry.businessId);
    const mine = library.find((row) => row.id === entry.id)!;
    expect(mine).toMatchObject({ title: entry.title, alreadyAdded: true });
    // A rendered sample, not a template body with `%token` in it.
    expect(mine.sample).toBe("سارا محمدی عزیز، سفارش شما آماده است.");
    expect(JSON.stringify(mine)).not.toMatch(/%token|provider|template_id/i);
    // Issue #902 §5f — the ordered domain variables travel with the entry so the
    // tenant screen can name what the message needs, in first-party words and
    // without the provider's `%token` notation.
    expect(mine.variables).toEqual(["customer_name"]);
    // An entry the business was not offered is simply absent, not present-and-
    // forbidden: the library is what the business may have, not a catalogue of
    // everything it cannot.
    expect(library.some((row) => row.title === "کد ورود")).toBe(true);
  });
});
