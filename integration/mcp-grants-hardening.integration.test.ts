/**
 * Issue #883 wave 2 — the grant, recovery and revalidation behaviours that
 * only a real database can prove. `mcp-connector.integration.test.ts` covers
 * the oauth round trip and the P0 baseline; this file covers what wave 2
 * added on top of it:
 *
 *   §1  — grants at mint decide the catalogue a connection sees, and a
 *         single-branch pin both hides business-wide tools and forbids
 *         cross-branch writes;
 *   A5  — an idempotency key reused with a DIFFERENT payload is a conflict,
 *         never a second execution, and raced duplicates land exactly once;
 *   A4  — a stale `processing` claim is surfaced as failed+requiresReview,
 *         never silently replayed;
 *   A3  — approval re-validates the complete originating grant (expiry,
 *         app grant, authorizer-of-record, approver's own permissions), and
 *         narrowing through the service dismisses the queue in-band;
 *   risk — an `always_approve` action queues even on an `apply` connection.
 *
 * Every assertion is exact: no AI provider sits in any of these paths.
 */
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let mcpAuth: typeof import("../src/lib/mcp/auth");
let mcpServer: typeof import("../src/lib/mcp/server");
let connections: typeof import("../src/lib/mcp/connections-service");
let writeService: typeof import("../src/lib/mcp/write-service");

const shop = {
  businessId: "",
  locationId: "",
  userId: "",
  menuItemId: "",
  customerId: "",
};
/** A second owner, kept ACTIVE so they can decide what a lapsed authorizer queued. */
const owner2 = { userId: "" };
/** A till member: carries menu/orders grants, never accounting or crm write. */
const cashier = { userId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function bearer(token: string): Pick<Request, "headers"> {
  return { headers: new Headers({ authorization: `Bearer ${token}` }) } as Pick<Request, "headers">;
}

/**
 * The explicit "no narrowing" grant document the connections screen sends for
 * a full-access mint: every app at scope level, every branch. It parses as
 * legacy (empty apps + "all") yet is explicit, which minting now requires.
 */
const FULL_GRANTS = { apps: {}, branches: "all" } as const;

beforeAll(async () => {
  databaseName = `pos_mcp883_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  mcpAuth = await import("../src/lib/mcp/auth");
  mcpServer = await import("../src/lib/mcp/server");
  connections = await import("../src/lib/mcp/connections-service");
  writeService = await import("../src/lib/mcp/write-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedCafe(name = "Cafe883") {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;

  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  const userId = user.rows[0].id;

  const second = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک دوم', $2, 'x') RETURNING id`,
    [businessId, `owner2-${randomUUID().slice(0, 8)}@example.test`],
  );
  const secondOwnerId = second.rows[0].id;

  const till = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'cashier', 'صندوقدار', $2, 'x') RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.test`],
  );
  const cashierId = till.rows[0].id;

  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id",
    [locationId],
  );
  const menuItem = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price)
     VALUES ($1, $2, 'قهوه', 500000) RETURNING id`,
    [locationId, category.rows[0].id],
  );

  const customer = await db.query<{ id: string }>(
    // 0137 renamed `customers` to `parties`: customer_id FKs across the
    // schema track the table by OID, but a raw INSERT needs the new name.
    `INSERT INTO parties (business_id, location_id, name, role, roles)
     VALUES ($1, $2, 'مشتری تست', 'customer', ARRAY['customer']::text[]) RETURNING id`,
    [businessId, locationId],
  );

  // The entitlement the whole MCP realm is gated on; default-OFF elsewhere.
  await db.query(
    "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'api_platform', true)",
    [businessId],
  );

  return {
    businessId,
    locationId,
    userId,
    secondOwnerId,
    cashierId,
    menuItemId: menuItem.rows[0].id,
    customerId: customer.rows[0].id,
  };
}

beforeEach(async () => {
  for (const table of [
    "mcp_oauth_tokens",
    "mcp_oauth_codes",
    "ai_action_audit",
    "mcp_connections",
    "mcp_oauth_clients",
    "menu_items",
    "menu_categories",
    "parties",
    "users",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
  const seeded = await seedCafe();
  shop.businessId = seeded.businessId;
  shop.locationId = seeded.locationId;
  shop.userId = seeded.userId;
  shop.menuItemId = seeded.menuItemId;
  shop.customerId = seeded.customerId;
  owner2.userId = seeded.secondOwnerId;
  cashier.userId = seeded.cashierId;
});

/** Mint a static connection; returns the token AND the connection id (the
 * service's contract is explicit grants, so callers name them). */
async function mintToken(input: {
  scopes: string[];
  writeMode?: "apply" | "approve";
  locationId?: string;
  userId?: string;
  expiresInDays?: number | null;
  grants?: unknown;
}): Promise<{ token: string; connectionId: string }> {
  const result = await dbLib.withTenant(shop.businessId, () =>
    connections.createStaticMcpConnection(shop.businessId, input.userId ?? shop.userId, {
      name: "Codex",
      locationId: input.locationId ?? shop.locationId,
      scopes: input.scopes,
      writeMode: input.writeMode ?? "approve",
      expiresInDays: input.expiresInDays ?? null,
      grants: input.grants ?? FULL_GRANTS,
    }),
  );
  if (!result.ok) throw new Error(`could not mint token: ${result.error}`);
  return { token: result.token, connectionId: result.connection.id };
}

async function call(token: string, method: string, params: Record<string, unknown> = {}) {
  const outcome = await mcpAuth.withMcpScope(bearer(token), (auth) =>
    mcpServer.dispatchMcpMessage(auth, { kind: "request", id: 1, method, params }),
  );
  if (!outcome.ok) throw new Error(`auth failed: ${outcome.error}`);
  return outcome.value;
}

function resultOf(response: unknown): Record<string, unknown> {
  const value = response as { result?: unknown; error?: unknown };
  if (value.error) throw new Error(`rpc error: ${JSON.stringify(value.error)}`);
  return value.result as Record<string, unknown>;
}

function structuredOf(response: Record<string, unknown>) {
  return (response as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function priceOf(itemId: string): Promise<number> {
  const { rows } = await db.query<{ price: string }>("SELECT price FROM menu_items WHERE id = $1", [
    itemId,
  ]);
  return Number(rows[0].price);
}

/** Queue a menu-price write on an approve-mode connection; returns audit id. */
async function proposePrice(
  amount: number,
  grants: unknown = FULL_GRANTS,
  userId?: string,
): Promise<string> {
  const { token } = await mintToken({
    scopes: ["pos.read", "pos.write"],
    writeMode: "approve",
    userId,
    grants,
  });
  await call(token, "tools/call", {
    name: "write_menu_item_price",
    arguments: { menuItemId: shop.menuItemId, price: amount },
  });
  const [pending] = await dbLib.withTenant(shop.businessId, () =>
    connections.listMcpPendingActions(shop.businessId),
  );
  return pending.id;
}

function decide(auditId: string, deciderUserId: string = shop.userId) {
  return dbLib.withTenant(shop.businessId, () =>
    writeService.decideMcpPendingAction({
      businessId: shop.businessId,
      auditId,
      decision: "approve",
      deciderUserId,
    }),
  );
}

async function auditRow(auditId: string) {
  const { rows } = await db.query<{ status: string; result: Record<string, unknown> | null }>(
    "SELECT status, result FROM ai_action_audit WHERE id = $1",
    [auditId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------

describe("§1: grants decide the catalogue, the branch pin bites", () => {
  it("a CRM-read-only connection sees CRM reads, no writes, nothing else", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      grants: { apps: { crm: { read: true, write: false } }, branches: "all" },
    });
    const listed = resultOf(await call(token, "tools/list")) as { tools: { name: string }[] };
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain("find_customers");
    expect(names).not.toContain("run_report"); // pos app not granted
    expect(names.some((name) => name.startsWith("write_"))).toBe(false);
    // And the native status tool needs a WRITABLE app, which crm-read is not.
    expect(names).not.toContain("get_write_status");
  });

  it("an explicit legacy-shaped grant keeps the pre-wave-2 catalogue", async () => {
    const { token } = await mintToken({ scopes: ["pos.read", "pos.write"], grants: FULL_GRANTS });
    const listed = resultOf(await call(token, "tools/list")) as { tools: { name: string }[] };
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain("get_branch_comparison");
    expect(names).toContain("write_menu_item_price");
    expect(names).toContain("get_write_status");
  });

  it("a single-branch pin hides business-wide reads and forbids cross-branch writes", async () => {
    // A second branch with its own menu item, priced at 300,000.
    const otherLocation = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'West') RETURNING id",
      [shop.businessId],
    );
    const otherCat = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id",
      [otherLocation.rows[0].id],
    );
    const otherItem = await db.query<{ id: string }>(
      "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای', 300000) RETURNING id",
      [otherLocation.rows[0].id, otherCat.rows[0].id],
    );

    const pinnedGrants = {
      apps: {
        pos: { read: true, write: true },
        crm: { read: true, write: false },
      },
      branches: [shop.locationId],
    };
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "apply",
      grants: pinnedGrants,
    });

    const listed = resultOf(await call(token, "tools/list")) as { tools: { name: string }[] };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).not.toContain("get_branch_comparison"); // business_wide, hidden by the pin
    expect(names).toContain("find_items"); // pinned reads stay

    const outcome = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: otherItem.rows[0].id, price: 700_000 },
      }),
    );
    const payload = structuredOf(outcome);
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("branch_forbidden");
    expect(await priceOf(otherItem.rows[0].id)).toBe(300_000);
  });

  it("a stored closed-grants document exposes no tools at all", async () => {
    // Rows like this only exist when a production bug (or a hand edit) wrote
    // one — validation refuses to mint it. The dispatcher must still fail
    // closed rather than treat it as legacy-full.
    const rawToken = `posmcp_${randomUUID().replaceAll("-", "")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.query(
      `INSERT INTO mcp_connections
         (business_id, location_id, name, scopes, write_mode, origin,
          token_prefix, token_hash, grants, created_by, authorized_by)
       VALUES ($1, $2, 'Closed', ARRAY['pos.read','pos.write'], 'approve', 'token',
               $3, $4, '{"apps":{},"branches":[]}'::jsonb, $5, $5)`,
      [shop.businessId, shop.locationId, rawToken.slice(0, 12), tokenHash, shop.userId],
    );

    const listed = resultOf(await call(rawToken, "tools/list")) as { tools: { name: string }[] };
    expect(listed.tools).toEqual([]);

    const resources = resultOf(await call(rawToken, "resources/list")) as {
      resources: { uri: string }[];
    };
    expect(resources.resources).toEqual([]);
  });
});

describe("A5: idempotency conflict handling", () => {
  it("a re-used key with a DIFFERENT payload conflicts and changes nothing", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "apply",
    });

    const first = structuredOf(
      resultOf(
        await call(token, "tools/call", {
          name: "write_menu_item_price",
          arguments: { menuItemId: shop.menuItemId, price: 710_000 },
          _meta: { idempotencyKey: "k-price-1" },
        }),
      ),
    );
    expect(first.status).toBe("applied");

    const second = structuredOf(
      resultOf(
        await call(token, "tools/call", {
          name: "write_menu_item_price",
          arguments: { menuItemId: shop.menuItemId, price: 720_000 },
          _meta: { idempotencyKey: "k-price-1" },
        }),
      ),
    );
    expect(second.status).toBe("failed");
    expect(second.error).toBe("idempotency_conflict");

    expect(await priceOf(shop.menuItemId)).toBe(710_000);
    // Exactly ONE audit row: the conflicting replay never inserts its own.
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM ai_action_audit WHERE business_id = $1",
      [shop.businessId],
    );
    expect(rows.map((r) => r.status)).toEqual(["applied"]);
  });

  it("raced duplicates with the same key apply exactly once", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "apply",
    });
    const attempt = () =>
      call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: shop.menuItemId, price: 800_000 },
        _meta: { idempotencyKey: "k-race-1" },
      });

    const [a, b] = await Promise.all([attempt(), attempt()]);
    // Deterministic contract: one claimant executes, the other replays the
    // durable row. The replay either sees the final outcome ("applied") or
    // observes the claim mid-flight ("in_flight"); a second execution is
    // what must NEVER happen. Both hang on the SAME audit id.
    const statuses = [a, b].map((outcome) => structuredOf(resultOf(outcome)));
    const auditIds = new Set(statuses.map((s) => String(s.auditId)));
    expect(auditIds.size).toBe(1);
    for (const stored of statuses) {
      expect(["applied", "in_flight"]).toContain(stored.status);
    }

    expect(await priceOf(shop.menuItemId)).toBe(800_000);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ai_action_audit WHERE business_id = $1",
      [shop.businessId],
    );
    expect(Number(rows[0].count)).toBe(1);

    // Whatever the race's loser saw, polling afterwards settles on applied.
    const polled = structuredOf(
      resultOf(
        await call(token, "tools/call", {
          name: "get_write_status",
          arguments: { auditId: [...auditIds][0] },
        }),
      ),
    );
    expect(polled.status).toBe("applied");
  });
});

describe("A4: an interrupted claim is surfaced, never replayed", () => {
  it("a stale processing row fails with requiresReview when the queue is next listed", async () => {
    // Keep THIS connection's token: only it may poll the row's outcome.
    const { token } = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 910_000 },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    const auditId = pending.id;

    await db.query(
      `UPDATE ai_action_audit
          SET status = 'processing', processing_started_at = now() - interval '20 minutes'
        WHERE id = $1`,
      [auditId],
    );

    // The lazy reconciler runs on the pending surface…
    await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );

    const row = await auditRow(auditId);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "interrupted", requiresReview: true });
    // …and the price was NOT touched by some hidden retry.
    expect(await priceOf(shop.menuItemId)).toBe(500_000);

    // The SAME connection learns the same failed verdict through its native tool…
    const own = structuredOf(
      resultOf(
        await call(token, "tools/call", { name: "get_write_status", arguments: { auditId } }),
      ),
    );
    expect(own.status).toBe("failed");
    expect(own.requiresReview).toBe(true);

    // …while a DIFFERENT connection probing the very same audit id learns
    // exactly "unknown" — a connection may never observe another's traffic.
    const { token: otherToken } = await mintToken({ scopes: ["pos.read", "pos.write"] });
    const other = structuredOf(
      resultOf(
        await call(otherToken, "tools/call", { name: "get_write_status", arguments: { auditId } }),
      ),
    );
    expect(other.status).toBe("unknown");
  });
});

describe("A3: approval revalidates the complete originating grant", () => {
  it("a connection that expired between propose and approve cannot be spent", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "approve",
      expiresInDays: 1,
    });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 920_000 },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    // The table's `mcp_connections_expiry_after_creation` CHECK forbids
    // backdating expiry, so walk the whole row's clock into the past instead.
    await db.query(
      `UPDATE mcp_connections
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        WHERE business_id = $1`,
      [shop.businessId],
    );

    expect(await decide(pending.id)).toEqual({ ok: false, error: "not_found" });
    const row = await auditRow(pending.id);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "connection_expired" });
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("a narrowed app grant fails the queued write at approval time, even edited behind the panel", async () => {
    const auditId = await proposePrice(930_000);
    // Simulate a race: the panel's patch handler would cancel in-band (next
    // test), but a grants edit that bypasses it must still lose at approval.
    await db.query(
      `UPDATE mcp_connections
          SET scopes = ARRAY['pos.read']::text[]
        WHERE business_id = $1`,
      [shop.businessId],
    );

    expect(await decide(auditId)).toEqual({ ok: false, error: "not_found" });
    const row = await auditRow(auditId);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "connection_narrowed" });
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("a grant edit dropping the action's app fails the queued write with grant_revoked", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "approve",
      grants: {
        apps: { crm: { read: true, write: true }, pos: { read: true, write: true } },
        branches: "all",
      },
    });
    await call(token, "tools/call", {
      name: "write_crm_customer_note",
      arguments: { customerId: shop.customerId, body: "یادداشت آزمایشی" },
    });
    const [pending] = await dbLib
      .withTenant(shop.businessId, () =>
        connections.listMcpPendingActions(shop.businessId),
      )
      .then((list) => list.filter((row) => row.actionType === "crm.customer.note"));

    await db.query(
      `UPDATE mcp_connections
          SET grants = '{"apps":{"pos":{"read":true,"write":true}},"branches":"all"}'::jsonb
        WHERE id = $1`,
      [pending.connectionId],
    );

    expect(await decide(pending.id)).toEqual({ ok: false, error: "not_found" });
    const row = await auditRow(pending.id);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "grant_revoked" });
  });

  it("a deactivated authorizer of record cannot have their queued write approved", async () => {
    const auditId = await proposePrice(950_000);
    await db.query("UPDATE users SET is_active = false WHERE id = $1", [shop.userId]);

    expect(await decide(auditId, owner2.userId)).toEqual({ ok: false, error: "not_found" });
    const row = await auditRow(auditId);
    expect(row.status).toBe("failed");
    expect(row.result).toMatchObject({ error: "authorizer_ineligible" });
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("an under-privileged approver releases the claim back to proposed", async () => {
    // A till member legitimately holds crmManage (logging a call is floor
    // work), so the denial must use a write the till truly cannot do: menu
    // prices are menuEdit, and a cashier preset never carries it.
    const auditId = await proposePrice(960_000);

    expect(await decide(auditId, cashier.userId)).toEqual({
      ok: false,
      error: "approver_forbidden",
    });
    const row = await auditRow(auditId);
    expect(row.status).toBe("proposed"); // back on the queue for a privileged approver
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("narrowing grants through the service dismisses queued proposals in-band", async () => {
    const { token, connectionId } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "approve",
      grants: {
        apps: { pos: { read: true, write: true }, crm: { read: true, write: true } },
        branches: "all",
      },
    });
    await call(token, "tools/call", {
      name: "write_crm_customer_note",
      arguments: { customerId: shop.customerId, body: "یادداشت قبل از تنگ‌کردن" },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    expect(pending.actionType).toBe("crm.customer.note");

    const outcome = await dbLib.withTenant(shop.businessId, () =>
      connections.updateMcpConnectionAccess(shop.businessId, connectionId, {
        scopes: ["pos.read", "pos.write"],
        writeMode: "approve",
        authorizedBy: shop.userId,
        grants: { apps: { pos: { read: true, write: true } }, branches: "all" },
      }),
    );
    expect(outcome.ok).toBe(true);

    const row = await auditRow(pending.id);
    expect(row.status).toBe("dismissed");
    expect(row.result).toMatchObject({ cancelled: "connection_narrowed" });
    // And nothing remains on the queue.
    expect(
      await dbLib.withTenant(shop.businessId, () =>
        connections.countMcpPendingActions(shop.businessId),
      ),
    ).toBe(0);
  });
});

describe("risk step-up: the registry outranks the write mode", () => {
  it("an always_approve action queues even on an apply connection, and applies nothing first", async () => {
    const { token } = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "apply",
    });
    const outcome = structuredOf(
      resultOf(
        await call(token, "tools/call", {
          name: "write_expense",
          arguments: {
            accountId: randomUUID(),
            paymentAccountId: randomUUID(),
            amount: 120_000,
            memo: "تست مرحله‌ای",
          },
        }),
      ),
    );
    expect(outcome.status).toBe("pending_approval");
    expect(String(outcome.message)).toContain("مالی");

    // Absolutely no ledger side effect yet.
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1",
      [shop.businessId],
    );
    expect(Number(rows[0].count)).toBe(0);

    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    expect(pending.actionType).toBe("expense.categorize");
    expect(pending.risk).toBe("high");
  });
});
