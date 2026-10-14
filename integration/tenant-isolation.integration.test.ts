/**
 * Phase 12 exit criterion: two businesses coexist in one database and neither
 * can read or write a single row belonging to the other.
 *
 * This test is the whole reason the isolation boundary is trustworthy, so it
 * is deliberately paranoid in two ways:
 *
 *  1. It connects as a purpose-created **unprivileged role**, not as the
 *     database owner. Superusers and BYPASSRLS roles ignore row-level security
 *     entirely — and the stock docker-compose.yml and the CI service both make
 *     `pos` a superuser. Run as `pos`, every assertion below would pass
 *     vacuously while proving nothing at all.
 *
 *  2. It asserts coverage over the live schema rather than a hand-written
 *     list: every table that carries tenant data must have RLS enabled AND
 *     forced. A future migration that adds a table without a policy fails here
 *     instead of leaking in production.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { EXEMPT_TABLES } from "../src/lib/tenant-tables";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_rls_test_role";
const APP_PASSWORD = "rls-test-password";

// EXEMPT_TABLES (tables with no tenant data, documented as exempt in 0021 +
// platform additions) is imported from tenant-tables.ts rather than kept as a
// second copy here — a hand-maintained duplicate is exactly what let the two
// drift apart before (migration 0130 updated this test's list but not
// tenant-export's, so a tenant export silently included global billing rows).

let databaseName: string;
let ownerClient: Client;
let appClient: Client;

const alpha = { businessId: "", locationId: "", categoryId: "", orderId: "" };
const beta = { businessId: "", locationId: "", categoryId: "", orderId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/** Creates a business with a location, a menu category and an order. */
async function seedBusiness(name: string, slug: string) {
  const biz = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;

  const loc = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;

  const category = await ownerClient.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, $2) RETURNING id",
    [locationId, `category-${slug}`],
  );

  const order = await ownerClient.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total)
     VALUES ($1, 1, 'takeaway', 'completed', 50000) RETURNING id`,
    [locationId],
  );

  return { businessId, locationId, categoryId: category.rows[0].id, orderId: order.rows[0].id };
}

/** Runs `fn` with the app connection scoped to `businessId`. */
async function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  await appClient.query("SELECT set_config('app.business_id', $1, false)", [businessId]);
  await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
  return fn();
}

async function countIn(table: string): Promise<number> {
  const { rows } = await appClient.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

beforeAll(async () => {
  databaseName = `pos_rls_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({
    databaseUrl: ownerUrl,
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();

  Object.assign(alpha, await seedBusiness("Alpha Cafe", "alpha"));
  Object.assign(beta, await seedBusiness("Beta Cafe", "beta"));
  await ownerClient.query(
    `INSERT INTO dashboard_widget_layout_state (business_id, role)
     VALUES ($1, 'owner'), ($2, 'owner')`,
    [alpha.businessId, beta.businessId],
  );

  appClient = new Client({
    connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }),
  });
  await appClient.connect();
}, 120_000);

afterAll(async () => {
  await appClient?.end();
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

describe("the test is actually testing something", () => {
  it("connects as a role that row-level security applies to", async () => {
    // If this fails, every other assertion in this file is vacuous.
    const { rows } = await appClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("seeded both businesses", async () => {
    const { rows } = await ownerClient.query<{ n: string }>("SELECT count(*) AS n FROM businesses");
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe("every tenant table is protected", () => {
  it("has RLS enabled and forced, with a policy", async () => {
    const { rows } = await ownerClient.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const unprotected = rows
      .filter((r) => !EXEMPT_TABLES.has(r.relname))
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || Number(r.policies) === 0)
      .map((r) => r.relname);

    expect(unprotected, `tables missing tenant isolation: ${unprotected.join(", ")}`).toEqual([]);
    expect(rows.length).toBeGreaterThan(50);
  });

  it("every policy's actual expression scopes by business, not just exists", async () => {
    const { rows } = await ownerClient.query<{
      relname: string;
      using_expr: string | null;
      check_expr: string | null;
    }>(
      `SELECT c.relname,
              pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE p.polname = 'tenant_isolation'
        ORDER BY c.relname`,
    );
    expect(rows.length).toBeGreaterThan(50);

    const SKIP_CHECK_CLAUSE = new Set(["platform_users"]);

    const BYPASS = /app_rls_bypass\(\)/;
    const SCOPED = /app_current_business\(\)|app_owns_location\(/;

    const bad: string[] = [];
    for (const r of rows) {
      const clauses: [string, string | null][] = [
        ["using", r.using_expr],
        ...(SKIP_CHECK_CLAUSE.has(r.relname) ? [] : ([["check", r.check_expr]] as [string, string | null][])),
      ];
      for (const [label, expr] of clauses) {
        if (!expr || !BYPASS.test(expr) || !SCOPED.test(expr)) {
          bad.push(`${r.relname} (${label})`);
        }
      }
    }
    expect(bad, `policies not following the safe template: ${bad.join(", ")}`).toEqual([]);
  });

  it("exempts only infrastructure and the platform realm", async () => {
    for (const table of EXEMPT_TABLES) {
      if (table.startsWith("platform_")) continue;

      const { rows } = await ownerClient.query<{ has_business: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
              AND column_name IN ('business_id', 'location_id')
         ) AS has_business`,
        [table],
      );
      expect(rows[0].has_business, `${table} is exempt but carries a tenant column`).toBe(false);
    }

    // Sorted, because the actual side is `.sort()`ed above — a name in the wrong
    // slot here fails the assertion even when the set is exactly right.
    expect([...EXEMPT_TABLES].filter((t) => t.startsWith("platform_")).sort()).toEqual([
      "platform_admins",
      "platform_ai_gateway",
      // Issue #812 — the Superadmin AI control plane's global half. The runtime
      // mode → LiteLLM alias map is a platform catalogue every business reads the
      // same published rows of, so it carries no business_id. Its tenant-facing
      // counterparts (ai_agent_assignments, ai_memory, ai_research_runs,
      // ai_research_sources) are RLS-protected and absent from this list.
      "platform_ai_modes",
      "platform_audit_log",
      // Migration 0132 — the console's whole-system backup. Its config, run
      // history, hashed peer tokens, the peers this install may restore from, and
      // the restore log: all deployment-wide, none of it carrying a business_id,
      // so none of it reachable through a tenant connection. See
      // src/lib/tenant-tables.ts for the reasoning.
      "platform_backup_config",
      "platform_backup_peers",
      "platform_backup_runs",
      "platform_backup_tokens",
      // Migration 0139 — the console's CMS control plane: the eshobe-cms address and
      // its platform key (encrypted), the mirror of every site on that deployment,
      // and the log of every sync. One CMS serves every business, so none of it has
      // a business_id; the per-business half (eshobe_cms_connections, 0122) is
      // RLS-protected and is not listed here.
      "platform_cms_config",
      "platform_cms_sites",
      "platform_cms_sync_runs",
      // Migration 0149 — the singleton S3/Parspack connection and price policy
      // behind every business's media library. One bucket credential for the
      // deployment, no business_id; tenant separation happens inside the bucket
      // (per-business key prefixes) and in the RLS-protected media_* tables.
      "platform_media_config",
      // Phase 37 — singleton message provider config + rates (no business_id;
      // the business side of messaging billing is RLS-protected).
      "platform_message_config",
      // Migration 0130 — singleton payment gateway config (Zarinpal merchant
      // id etc.), no business_id; the business side of billing is RLS-protected.
      "platform_payment_config",
      "platform_push_config",
      // Migration 0187: global release catalogue; device telemetry is tenant-scoped.
      "platform_releases",
      "platform_restore_runs",
      // Phase 24 — the deployment-wide SMS gateway credentials (Kavenegar) the
      // MFA challenge sends through. A singleton with no business_id, the same
      // shape as platform_ai_config: one account, configured once by a
      // super-admin, holding no tenant data.
      "platform_sms_config",
    ]);
  });

  it("makes reporting views follow the caller rather than their owner", async () => {
    const { rows } = await ownerClient.query<{ viewname: string; options: string[] | null }>(
      `SELECT c.relname AS viewname, c.reloptions AS options
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'v' AND c.relname LIKE 'v\\_%'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const view of rows) {
      expect(
        (view.options ?? []).some((o) => o.replace(/\s/g, "").toLowerCase() === "security_invoker=on"),
        `view ${view.viewname} does not set security_invoker`,
      ).toBe(true);
    }
  });

  /**
   * The assertion above reads the catalog flag; this one reads the data.
   *
   * Migration 0144 replaced v_inventory_valuation with CREATE OR REPLACE VIEW,
   * which resets reloptions to NULL — the view silently reverted to running as
   * its owner and returned every business's inventory to every caller (0146
   * repairs it). The flag assertion caught that, but only because someone had
   * set the flag in the first place: a view that leaks for a different reason
   * would satisfy the catalog check and still leak.
   *
   * So this one queries the real thing, as the unprivileged app role, with one
   * business's tenant context set, and demands it sees exactly its own row.
   */
  it("returns only the caller's own rows when read through a reporting view", async () => {
    const probeName = (label: string) => `valuation-probe-${label}`;
    for (const [label, business] of [
      ["alpha", alpha],
      ["beta", beta],
    ] as const) {
      await ownerClient.query(
        `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial, is_active)
         VALUES ($1, $2::text, 'kg', 1000, 500000, true)`,
        [business.locationId, probeName(label)],
      );
    }

    // v_inventory_valuation is the view 0144 broke; v_inventory_nrv_valuation
    // reads through it and so inherited the leak despite its own correct flag.
    // Both are checked — repairing only the first would leave the second open.
    for (const view of ["v_inventory_valuation", "v_inventory_nrv_valuation"]) {
      await asBusiness(alpha.businessId, async () => {
        const { rows } = await appClient.query<{ item_name: string }>(
          `SELECT item_name FROM ${view} WHERE item_name LIKE 'valuation-probe-%' ORDER BY item_name`,
        );
        expect(
          rows.map((row) => row.item_name),
          `${view} leaked another business's inventory to the caller`,
        ).toEqual([probeName("alpha")]);
      });
    }

    // With no tenant context at all it must fail closed, not open.
    await appClient.query("SELECT set_config('app.business_id', '', false)");
    const { rows: unscoped } = await appClient.query<{ n: string }>(
      "SELECT count(*) AS n FROM v_inventory_valuation",
    );
    expect(Number(unscoped[0].n), "v_inventory_valuation returned rows with no tenant context").toBe(0);
  });
});

describe("reads are confined to the current business", () => {
  it("sees only its own business, location and menu", async () => {
    await asBusiness(alpha.businessId, async () => {
      expect(await countIn("businesses")).toBe(1);
      expect(await countIn("locations")).toBe(1);
      expect(await countIn("menu_categories")).toBe(1);
      expect(await countIn("dashboard_widget_layout_state")).toBe(1);

      const { rows } = await appClient.query<{ name: string }>("SELECT name FROM menu_categories");
      expect(rows[0].name).toBe("category-alpha");
    });

    await asBusiness(beta.businessId, async () => {
      const { rows } = await appClient.query<{ name: string }>("SELECT name FROM menu_categories");
      expect(rows[0].name).toBe("category-beta");
      expect(await countIn("dashboard_widget_layout_state")).toBe(1);
    });
  });

  it("cannot reach another business's rows even by naming their primary key", async () => {
    await asBusiness(alpha.businessId, async () => {
      const category = await appClient.query("SELECT * FROM menu_categories WHERE id = $1", [
        beta.categoryId,
      ]);
      expect(category.rowCount).toBe(0);

      const order = await appClient.query("SELECT * FROM orders WHERE id = $1", [beta.orderId]);
      expect(order.rowCount).toBe(0);

      const business = await appClient.query("SELECT * FROM businesses WHERE id = $1", [
        beta.businessId,
      ]);
      expect(business.rowCount).toBe(0);
    });
  });

  it("cannot read or create another business's role-default layout state", async () => {
    await asBusiness(alpha.businessId, async () => {
      const foreign = await appClient.query(
        "SELECT * FROM dashboard_widget_layout_state WHERE business_id = $1",
        [beta.businessId],
      );
      expect(foreign.rowCount).toBe(0);

      await expect(appClient.query(
        `INSERT INTO dashboard_widget_layout_state (business_id, role)
         VALUES ($1, 'manager')`,
        [beta.businessId],
      )).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("reads nothing at all with no tenant context — fail closed, not fail open", async () => {
    await appClient.query("SELECT set_config('app.business_id', '', false)");
    await appClient.query("SELECT set_config('app.rls_bypass', '', false)");

    expect(await countIn("businesses")).toBe(0);
    expect(await countIn("locations")).toBe(0);
    expect(await countIn("menu_categories")).toBe(0);
    expect(await countIn("orders")).toBe(0);
    expect(await countIn("dashboard_widget_layout_state")).toBe(0);
    expect(await countIn("users")).toBe(0);
  });

  it("ignores a malformed tenant setting instead of erroring open", async () => {
    await appClient.query("SELECT set_config('app.business_id', 'not-a-uuid', false)");
    await expect(countIn("menu_categories")).rejects.toThrow();
  });
});

describe("writes are confined to the current business", () => {
  it("refuses an insert that would land in another business", async () => {
    await asBusiness(alpha.businessId, async () => {
      await expect(
        appClient.query("INSERT INTO menu_categories (location_id, name) VALUES ($1, 'sneaky')", [
          beta.locationId,
        ]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("refuses to move one of its own rows into another business", async () => {
    await asBusiness(alpha.businessId, async () => {
      await expect(
        appClient.query("UPDATE menu_categories SET location_id = $1 WHERE id = $2", [
          beta.locationId,
          alpha.categoryId,
        ]),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("silently affects nothing when updating or deleting another business's rows", async () => {
    await asBusiness(alpha.businessId, async () => {
      const updated = await appClient.query("UPDATE menu_categories SET name = 'hacked' WHERE id = $1", [
        beta.categoryId,
      ]);
      expect(updated.rowCount).toBe(0);

      const deleted = await appClient.query("DELETE FROM menu_categories WHERE id = $1", [
        beta.categoryId,
      ]);
      expect(deleted.rowCount).toBe(0);
    });

    const { rows } = await ownerClient.query<{ name: string }>(
      "SELECT name FROM menu_categories WHERE id = $1",
      [beta.categoryId],
    );
    expect(rows[0].name).toBe("category-beta");
  });

  it("protects child rows reachable only through a parent", async () => {
    const entry = await ownerClient.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo)
       VALUES ($1, current_date, 'beta only') RETURNING id`,
      [beta.businessId],
    );
    const account = await ownerClient.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset') RETURNING id`,
      [beta.businessId],
    );
    await ownerClient.query(
      "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1000, 0)",
      [entry.rows[0].id, account.rows[0].id],
    );

    await asBusiness(alpha.businessId, async () => {
      expect(await countIn("journal_lines")).toBe(0);
      expect(await countIn("journal_entries")).toBe(0);

      await expect(
        appClient.query(
          "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 500, 0)",
          [entry.rows[0].id, account.rows[0].id],
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    await asBusiness(beta.businessId, async () => {
      expect(await countIn("journal_lines")).toBe(1);
    });
  });

  it("protects a direct business_id table (business_features) from cross-tenant read and write", async () => {
    const override = await ownerClient.query<{ business_id: string; flag_key: string }>(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       VALUES ($1, 'inventory', false) RETURNING business_id, flag_key`,
      [beta.businessId],
    );

    await asBusiness(alpha.businessId, async () => {
      expect(await countIn("business_features")).toBe(0);

      const { rows } = await appClient.query(
        "SELECT * FROM business_features WHERE business_id = $1 AND flag_key = $2",
        [override.rows[0].business_id, override.rows[0].flag_key],
      );
      expect(rows).toHaveLength(0);

      await expect(
        appClient.query(
          "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ledger', false)",
          [beta.businessId],
        ),
      ).rejects.toThrow(/row-level security/i);

      const deleted = await appClient.query(
        "DELETE FROM business_features WHERE business_id = $1 AND flag_key = $2",
        [override.rows[0].business_id, override.rows[0].flag_key],
      );
      expect(deleted.rowCount).toBe(0);
    });

    await asBusiness(beta.businessId, async () => {
      expect(await countIn("business_features")).toBe(1);
    });
  });

  it("cannot switch off its own isolation", async () => {
    await asBusiness(alpha.businessId, async () => {
      await expect(
        appClient.query("ALTER TABLE menu_categories DISABLE ROW LEVEL SECURITY"),
      ).rejects.toThrow();
      await expect(
        appClient.query("DROP POLICY tenant_isolation ON menu_categories"),
      ).rejects.toThrow();
    });
  });
});

describe("the documented bypass", () => {
  it("sees every business, which is why its use is confined to login and platform code", async () => {
    await appClient.query("SELECT set_config('app.business_id', '', false)");
    await appClient.query("SELECT set_config('app.rls_bypass', 'on', false)");
    expect(await countIn("businesses")).toBe(2);

    await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
    expect(await countIn("businesses")).toBe(0);
  });
});

describe("cross-business identity", () => {
  it("lets one person hold a membership in two businesses", async () => {
    const identity = await ownerClient.query<{ id: string }>(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ('group.owner@example.com', 'x', 'Group Owner') RETURNING id`,
    );
    const platformUserId = identity.rows[0].id;

    for (const [business, role] of [
      [alpha, "owner"],
      [beta, "manager"],
    ] as const) {
      await ownerClient.query(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
         VALUES ($1, $2, $3, 'Group Owner', 'group.owner@example.com')`,
        [business.businessId, platformUserId, role],
      );
    }

    const { rows } = await ownerClient.query<{ role: string; business_id: string }>(
      "SELECT role, business_id FROM users WHERE platform_user_id = $1 ORDER BY role::text",
      [platformUserId],
    );
    expect(rows.map((r) => r.role)).toEqual(["manager", "owner"]);

    await asBusiness(alpha.businessId, async () => {
      const { rows: alphaRows } = await appClient.query<{ role: string }>(
        "SELECT role FROM users WHERE platform_user_id = $1",
        [platformUserId],
      );
      expect(alphaRows).toHaveLength(1);
      expect(alphaRows[0].role).toBe("owner");
    });
  });

  it("stops a business from enumerating platform identities that aren't its members", async () => {
    await ownerClient.query(
      `INSERT INTO platform_users (email, password_hash, full_name)
       VALUES ('stranger@example.com', 'x', 'Stranger')`,
    );

    await asBusiness(alpha.businessId, async () => {
      const { rows } = await appClient.query<{ email: string }>("SELECT email FROM platform_users");
      expect(rows.map((r) => r.email)).not.toContain("stranger@example.com");
    });
  });
});
