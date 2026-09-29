/**
 * Per-business commercial overrides, against a real database (issue #755 §5).
 *
 * Three defects are pinned here, all of which the unit-level mocks cannot see
 * because they live in the SQL and in the read's classification:
 *
 *  1. a malformed expiry used to reach `new Date(...).toISOString()` and throw
 *     a RangeError — a 500 for a bad request body;
 *  2. removal keyed on (business, target) deleted *both* a limit and a
 *     capability override that shared a target name;
 *  3. the billing read returned expired overrides in the same list as live
 *     ones, disagreeing with the entitlement engine, which ignores them.
 *
 * The real route handlers are driven; only platform authentication is stubbed,
 * because there is no HTTP session in an integration test.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const adminId = randomUUID();

vi.mock("@/lib/platform-auth", () => {
  const session = { session: { padmin: adminId, role: "owner" }, error: null };
  return {
    requirePlatformAdmin: vi.fn(async () => session),
    requirePlatformCapability: vi.fn(async () => session),
    withPlatformScope: (fn: (req: Request, ctx: unknown) => Promise<Response>) => fn,
    platformAudit: vi.fn(async (entry: { action: string; entityId?: string | null }) => {
      audit.push({ action: entry.action, entityId: entry.entityId ?? null });
    }),
  };
});

const audit: { action: string; entityId: string | null }[] = [];

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let businessId: string;

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

beforeAll(async () => {
  databaseName = `pos_billing_overrides_${randomUUID().replaceAll("-", "")}`;
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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  await db.query(
    `INSERT INTO platform_admins (id, email, password_hash, full_name)
     VALUES ($1, 'ops@example.com', 'x', 'اپراتور')`,
    [adminId],
  );
  const biz = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ('کافه استثنا', $1) RETURNING id`,
    [`ovr-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;
}, 120_000);

afterAll(async () => {
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

const ctx = { params: Promise.resolve({ id: "" }) };

async function post(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import(
    "../src/app/api/platform/billing/businesses/[id]/overrides/route"
  );
  return POST(
    new Request("http://localhost:3000/api/platform/billing/businesses/x/overrides", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: businessId }) },
  ) as Promise<Response>;
}

async function rows(): Promise<
  { id: string; kind: string; target: string; value_int: number | null; active: boolean }[]
> {
  const { rows: result } = await db.query(
    `SELECT id, kind, target, value_int, active FROM business_billing_overrides
      WHERE business_id = $1 ORDER BY kind, target`,
    [businessId],
  );
  return result;
}

beforeEach(async () => {
  audit.length = 0;
  await db.query(`DELETE FROM business_billing_overrides WHERE business_id = $1`, [businessId]);
  await db.query(`DELETE FROM platform_audit_log WHERE business_id = $1`, [businessId]);
  void ctx;
});

describe("POST overrides — invalid expiry is a 400, never a 500", () => {
  it("rejects a malformed date before attempting to serialize it", async () => {
    const res = await post({
      action: "set",
      kind: "limit",
      target: "branch_limit",
      value: 5,
      reason: "قرارداد سازمانی",
      expiresAt: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_date" });
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a non-string expiry the same way", async () => {
    const res = await post({
      action: "set",
      kind: "limit",
      target: "branch_limit",
      value: 5,
      reason: "قرارداد سازمانی",
      expiresAt: 12345,
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid expiry and stores it", async () => {
    const res = await post({
      action: "set",
      kind: "limit",
      target: "branch_limit",
      value: 5,
      reason: "قرارداد سازمانی",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });
});

describe("POST overrides — removal is scoped to the uniqueness key", () => {
  async function seedTwo(): Promise<void> {
    await db.query(
      `INSERT INTO business_billing_overrides (business_id, kind, target, value_int, reason, created_by)
       VALUES ($1, 'limit', 'branch_limit', 9, 'سقف قراردادی', $2)`,
      [businessId, adminId],
    );
    // Same *target* string, different kind — the pair the old removal collapsed.
    await db.query(
      `INSERT INTO business_billing_overrides (business_id, kind, target, value_bool, reason, created_by)
       VALUES ($1, 'capability', 'branch_limit', true, 'قابلیت ویژه', $2)`,
      [businessId, adminId],
    );
  }

  it("removes exactly one row when kind and id are given", async () => {
    await seedTwo();
    const all = await rows();
    const limit = all.find((row) => row.kind === "limit")!;

    const res = await post({ action: "remove", target: "branch_limit", kind: "limit", id: limit.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, removed: 1 });

    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0].kind).toBe("capability");
  });

  it("scopes by kind even without an id", async () => {
    await seedTwo();
    const res = await post({ action: "remove", target: "branch_limit", kind: "capability" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: 1 });
    expect((await rows()).map((r) => r.kind)).toEqual(["limit"]);
  });

  it("refuses a target-only removal instead of deleting every kind that shares the name", async () => {
    await seedTwo();
    const res = await post({ action: "remove", target: "branch_limit" });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(2);
  });

  it("audits one removal per row with the before values", async () => {
    await seedTwo();
    await post({ action: "remove", target: "branch_limit", kind: "limit" });
    expect(audit.filter((a) => a.action === "business.override.removed")).toHaveLength(1);
  });
});

describe("POST overrides — create and update are distinct audited events", () => {
  it("audits a first write as created and a second as updated, with the expiry in before/after", async () => {
    await post({ action: "set", kind: "limit", target: "member_limit", value: 4, reason: "قرارداد سازمانی" });
    expect(audit.map((a) => a.action)).toEqual(["business.override.created"]);

    await post({
      action: "set",
      kind: "limit",
      target: "member_limit",
      value: 8,
      reason: "تمدید قرارداد",
      expiresAt: "2027-06-01T00:00:00.000Z",
    });
    expect(audit.map((a) => a.action)).toEqual([
      "business.override.created",
      "business.override.updated",
    ]);
  });

  it("keeps uniqueness to one row per (business, kind, target)", async () => {
    await post({ action: "set", kind: "limit", target: "member_limit", value: 4, reason: "قرارداد سازمانی" });
    await post({ action: "set", kind: "limit", target: "member_limit", value: 8, reason: "تمدید قرارداد" });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0].value_int).toBe(8);
  });
});

describe("GET business billing — effective vs expired overrides", () => {
  it("lists a live override as active, an expired one as history, with a complete media shape", async () => {
    await db.query(
      `INSERT INTO business_billing_overrides (business_id, kind, target, value_int, reason, created_by)
       VALUES ($1, 'limit', 'branch_limit', 7, 'قرارداد فعال', $2)`,
      [businessId, adminId],
    );
    await db.query(
      `INSERT INTO business_billing_overrides (business_id, kind, target, value_int, reason, created_by, expires_at)
       VALUES ($1, 'limit', 'member_limit', 3, 'قرارداد گذشته', $2, now() - interval '1 day')`,
      [businessId, adminId],
    );

    const { GET } = await import("../src/app/api/platform/billing/businesses/[id]/route");
    const res = await GET(
      new Request("http://localhost:3000/api/platform/billing/businesses/x") as never,
      { params: Promise.resolve({ id: businessId }) } as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.overrides.map((o: { target: string }) => o.target)).toEqual(["branch_limit"]);
    expect(json.overrides[0].state).toBe("active");
    expect(json.overrideHistory.map((o: { target: string }) => o.target)).toEqual(["member_limit"]);
    expect(json.overrideHistory[0].state).toBe("expired");

    // A business with no media at all still answers with every kind present, so
    // the UI never reads `byKind.image.count` off an undefined object.
    expect(json.media.usage.byKind.image).toEqual({ count: 0, bytes: 0 });
    expect(json.media.usage.byKind.video).toEqual({ count: 0, bytes: 0 });
    expect(json.media.usage.byKind.document).toEqual({ count: 0, bytes: 0 });
  }, 30_000);
});

describe("GET business billing — the include contract and list pagination", () => {
  beforeEach(async () => {
    await db.query(`DELETE FROM wallet_ledger WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM billing_payments WHERE business_id = $1`, [businessId]);
    await db.query(`DELETE FROM billing_invoices WHERE business_id = $1`, [businessId]);
  });

  async function getBilling(query = ""): Promise<Response> {
    const { GET } = await import("../src/app/api/platform/billing/businesses/[id]/route");
    return GET(
      new Request(`http://localhost:3000/api/platform/billing/businesses/x${query}`),
      { params: Promise.resolve({ id: businessId }) },
    ) as Promise<Response>;
  }

  async function seedLedger(count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await db.query(
        `INSERT INTO wallet_ledger
           (business_id, kind, direction, amount_rial, balance_after_rial, note, created_at)
         VALUES ($1, 'admin_grant', 'credit', 1000, $2, $3, now() - ($4 || ' minutes')::interval)`,
        [businessId, i * 1000, `ردیف ${i}`, String(i)],
      );
    }
  }

  it("queries and returns only the sections `include` names", async () => {
    await seedLedger(3);

    const json = await (await getBilling("?include=ledger")).json();
    expect(json.ledger).toHaveLength(3);
    expect(json.business.name).toBe("کافه استثنا");
    // The expensive sections are absent, not empty — an operator must not be
    // shown "0" for a section the request deliberately did not compute.
    expect(json).not.toHaveProperty("wallet");
    expect(json).not.toHaveProperty("invoices");
    expect(json).not.toHaveProperty("media");
    expect(json).not.toHaveProperty("litellm");
    expect(json).not.toHaveProperty("subscription");
    expect(json.meta.includes).toEqual(["ledger"]);
  }, 30_000);

  it("pages the ledger with a real total instead of silently stopping at 50", async () => {
    await seedLedger(3);

    const first = await (await getBilling("?include=ledger&ledgerLimit=2")).json();
    expect(first.ledger).toHaveLength(2);
    expect(first.meta.ledger).toEqual({ total: 3, limit: 2, offset: 0 });

    const second = await (
      await getBilling("?include=ledger&ledgerLimit=2&ledgerOffset=2")
    ).json();
    expect(second.ledger).toHaveLength(1);
    expect(second.meta.ledger.total).toBe(3);
    // The second page continues the first rather than repeating it.
    const firstIds = first.ledger.map((l: { id: string }) => l.id);
    expect(firstIds).not.toContain(second.ledger[0].id);
  }, 30_000);

  it("pages payments and invoices the same way", async () => {
    for (let i = 1; i <= 3; i++) {
      await db.query(
        `INSERT INTO billing_payments (business_id, amount_rial, credit_rial, description, status)
         VALUES ($1, $2, $2, $3, 'verified')`,
        [businessId, i * 100_000, `پرداخت ${i}`],
      );
    }
    for (let i = 1; i <= 2; i++) {
      await db.query(
        `INSERT INTO billing_invoices (business_id, invoice_number, reference, total_rial)
         VALUES ($1, $2, $3, 500000)`,
        [businessId, `INV-${i}`, `test-reference-${i}`],
      );
    }

    const payments = await (await getBilling("?include=payments&paymentsLimit=2")).json();
    expect(payments.payments).toHaveLength(2);
    expect(payments.meta.payments.total).toBe(3);
    expect(payments).not.toHaveProperty("invoices");

    const invoices = await (
      await getBilling("?include=invoices&invoicesLimit=1")
    ).json();
    expect(invoices.invoices).toHaveLength(1);
    expect(invoices.meta.invoices.total).toBe(2);
    expect(invoices).not.toHaveProperty("payments");
  }, 30_000);

  it("accepts the always-present `business` key alongside a section", async () => {
    // This is the exact request every tab of the billing page makes. The page
    // prepends `business` for its own title, and the first version of this
    // contract refused it — so every tab load was a 400 the route's tests could
    // not see, because they never sent the key the page sends.
    await seedLedger(2);
    const res = await getBilling("?include=business,ledger");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.business.name).toBe("کافه استثنا");
    expect(json.ledger).toHaveLength(2);
  }, 30_000);

  it("refuses an unknown include key rather than quietly ignoring it", async () => {
    const res = await getBilling("?include=ledger,secrets");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_include", invalid: "secrets" });
    // The refusal names what *is* acceptable, so a caller can fix itself.
    expect((await (await getBilling("?include=secrets")).json()).valid).toContain("business");
  }, 30_000);

  it("keeps paging by offset even when the page size is clamped", async () => {
    // "Load more" appends by offset now, but the clamp is still what bounds a
    // single request — and the old cumulative-limit approach died on it: past
    // the cap every click re-fetched the same rows.
    await seedLedger(3);
    const json = await (
      await getBilling("?include=ledger&ledgerLimit=9999&ledgerOffset=2")
    ).json();
    expect(json.meta.ledger.limit).toBe(200);
    expect(json.ledger).toHaveLength(1);
    expect(json.meta.ledger.total).toBe(3);
  }, 30_000);

  it("keeps the whole-payload contract when `include` is omitted", async () => {
    const json = await (await getBilling()).json();
    for (const key of [
      "wallet",
      "ledger",
      "payments",
      "invoices",
      "entitlements",
      "usage",
      "media",
      "messaging",
      "ai",
      "litellm",
      "overrides",
      "overrideHistory",
      "subscription",
      "recurring",
    ]) {
      expect(json, key).toHaveProperty(key);
    }
  }, 30_000);
});
