/**
 * Phase 34 exit criteria, against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves the four new tables
 * carry RLS like every other tenant table, and the pure modules' own unit tests
 * cover PKCE, redirect matching, scope narrowing and the tool catalogue. What
 * can only be proven here is the thing the feature *is*:
 *
 *   - an OAuth flow that starts at "paste a URL" and ends with a working
 *     connection: register → authorize → consent → code → token → tool call;
 *   - a read-only grant that cannot see, let alone call, a write tool;
 *   - a write in `apply` mode that really changes the menu, through the same
 *     executor a coworker job uses, with an audit row naming the connector;
 *   - a write in `approve` mode that changes NOTHING until a human says yes,
 *     and then applies the stored payload unchanged;
 *   - revocation that bites on the very next call, with no cache to wait out;
 *   - one business's connector never reaching another business's data.
 *
 * No AI provider is involved anywhere in this file: an MCP tool call is
 * deterministic server-side work, so every assertion here is exact.
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
let oauthService: typeof import("../src/lib/mcp/oauth-service");
let writeService: typeof import("../src/lib/mcp/write-service");

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const shop = { businessId: "", locationId: "", userId: "", menuItemId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function bearer(token: string): Pick<Request, "headers"> {
  return { headers: new Headers({ authorization: `Bearer ${token}` }) } as Pick<Request, "headers">;
}

beforeAll(async () => {
  databaseName = `pos_mcp_${randomUUID().replaceAll("-", "")}`;
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
  oauthService = await import("../src/lib/mcp/oauth-service");
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

/** A café with one menu item priced at 500,000 ﷼ (۵۰٬۰۰۰ تومان). */
async function seedCafe(name = "Cafe") {
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

  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id",
    [locationId],
  );
  const menuItem = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price)
     VALUES ($1, $2, 'قهوه', 500000) RETURNING id`,
    [locationId, category.rows[0].id],
  );

  // `api_platform` is the entitlement the whole MCP realm is gated on, and it
  // is default-OFF — worth a test noticing, so it is granted explicitly.
  await db.query(
    "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'api_platform', true)",
    [businessId],
  );

  return { businessId, locationId, userId: user.rows[0].id, menuItemId: menuItem.rows[0].id };
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
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
  Object.assign(shop, await seedCafe());
});

/** Mint a static-token connection the way the connections screen does. */
async function mintToken(input: {
  scopes: string[];
  writeMode?: "apply" | "approve";
  businessId?: string;
  locationId?: string;
  userId?: string;
}): Promise<string> {
  const businessId = input.businessId ?? shop.businessId;
  const result = await dbLib.withTenant(businessId, () =>
    connections.createStaticMcpConnection(businessId, input.userId ?? shop.userId, {
      name: "Codex",
      locationId: input.locationId ?? shop.locationId,
      scopes: input.scopes,
      writeMode: input.writeMode ?? "approve",
    }),
  );
  if (!result.ok) throw new Error(`could not mint token: ${result.error}`);
  return result.token;
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
  if (value.error) throw new Error(`json-rpc error: ${JSON.stringify(value.error)}`);
  return value.result as Record<string, unknown>;
}

async function priceOf(menuItemId: string): Promise<number> {
  const { rows } = await db.query<{ price: string }>("SELECT price FROM menu_items WHERE id = $1", [
    menuItemId,
  ]);
  return Number(rows[0].price);
}

// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("resolves a static token to its business and branch, with no session anywhere", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const auth = await mcpAuth.authenticateMcp(bearer(token));
    expect(auth).toMatchObject({
      businessId: shop.businessId,
      locationId: shop.locationId,
      scopes: ["pos.read"],
      authorizedByUserId: shop.userId,
    });
  });

  it("refuses a credential from another realm, and a token that was never issued", async () => {
    expect(await mcpAuth.authenticateMcp(bearer("posk_live_abc"))).toBeNull();
    expect(await mcpAuth.authenticateMcp(bearer("posmcp_nope"))).toBeNull();
  });

  it("records last_used_at, so an owner can see a connector is live", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    await mcpAuth.authenticateMcp(bearer(token));
    const { rows } = await db.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM mcp_connections",
    );
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("stops working on the very next call after a revoke — there is no cache to wait out", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    expect(await mcpAuth.authenticateMcp(bearer(token))).not.toBeNull();

    const { rows } = await db.query<{ id: string }>("SELECT id FROM mcp_connections");
    await dbLib.withTenant(shop.businessId, () =>
      connections.revokeMcpConnection(shop.businessId, rows[0].id),
    );

    expect(await mcpAuth.authenticateMcp(bearer(token))).toBeNull();
  });

  it("refuses everything when the business loses the api_platform entitlement", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    await db.query("UPDATE business_features SET enabled = false WHERE business_id = $1", [
      shop.businessId,
    ]);
    const outcome = await mcpAuth.withMcpScope(bearer(token), async () => "reached");
    expect(outcome).toEqual({ ok: false, error: "feature_disabled" });
  });

  it("never lets one business's connector reach another's data", async () => {
    const other = await seedCafe("Other");
    const token = await mintToken({
      scopes: ["pos.read"],
      businessId: other.businessId,
      locationId: other.locationId,
      userId: other.userId,
    });

    const auth = await mcpAuth.authenticateMcp(bearer(token));
    expect(auth?.businessId).toBe(other.businessId);

    // The other café's own item is invisible: RLS is the boundary, and the
    // connection's scope is what selects the tenant.
    const found = await call(token, "tools/call", {
      name: "find_items",
      arguments: { query: "قهوه" },
    });
    expect(JSON.stringify(resultOf(found))).not.toContain(shop.menuItemId);
  });
});

describe("the tool surface", () => {
  it("hands a read-only connection no write tools at all", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const listed = resultOf(await call(token, "tools/list")) as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.some((tool) => tool.name.startsWith("write_"))).toBe(false);
    expect(listed.tools.some((tool) => tool.name === "run_report")).toBe(true);
  });

  it("refuses a write tool a read-only connection asks for by name anyway", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const response = (await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 1 },
    })) as { error?: { message: string } };
    expect(response.error?.message).toContain("مجاز نیست");
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("answers initialize with this business's own name and its conventions", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const result = resultOf(await call(token, "initialize", { protocolVersion: "2025-06-18" })) as {
      protocolVersion: string;
      serverInfo: { title: string };
      instructions: string;
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo.title).toBe("Cafe");
    expect(result.instructions).toContain("RIAL");
    // A read-only connection must be told so, or a model promises changes it
    // cannot make.
    expect(result.instructions).toContain("READ-ONLY");
  });

  it("tells a write connection which of the two write modes it is in", async () => {
    const applyToken = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    const approveToken = await mintToken({
      scopes: ["pos.read", "pos.write"],
      writeMode: "approve",
    });
    const applyInit = resultOf(await call(applyToken, "initialize")) as { instructions: string };
    const approveInit = resultOf(await call(approveToken, "initialize")) as { instructions: string };
    expect(applyInit.instructions).toContain("takes effect immediately");
    expect(approveInit.instructions).toContain("waits in an approval list");
  });

  it("serves the resources that tell a model what this installation is", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const listed = resultOf(await call(token, "resources/list")) as {
      resources: Array<{ uri: string }>;
    };
    expect(listed.resources.map((r) => r.uri)).toContain("pos://app/conventions");

    const read = resultOf(
      await call(token, "resources/read", { uri: "pos://app/overview" }),
    ) as { contents: Array<{ text: string }> };
    expect(read.contents[0].text.length).toBeGreaterThan(0);

    const missing = (await call(token, "resources/read", { uri: "pos://nope" })) as {
      error?: { code: number };
    };
    expect(missing.error?.code).toBe(-32602);
  });

  it("runs a real read tool against real rows", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const result = resultOf(
      await call(token, "tools/call", { name: "find_items", arguments: { query: "قهوه" } }),
    ) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("قهوه");
  });

  it("answers ping, and never answers a notification", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    expect(resultOf(await call(token, "ping"))).toEqual({});

    const outcome = await mcpAuth.withMcpScope(bearer(token), (auth) =>
      mcpServer.dispatchMcpMessage(auth, {
        kind: "notification",
        method: "notifications/initialized",
        params: {},
      }),
    );
    expect(outcome).toEqual({ ok: true, value: null });
  });
});

describe("writing in apply mode", () => {
  it("changes the menu for real, through the executor a coworker job uses", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    const result = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: shop.menuItemId, price: 620_000 },
      }),
    ) as { structuredContent: { status: string } };

    expect(result.structuredContent.status).toBe("applied");
    expect(await priceOf(shop.menuItemId)).toBe(620_000);
  });

  it("records the write in the assistant's own audit trail, naming the connector", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 610_000 },
    });

    const { rows } = await db.query<{
      source: string;
      status: string;
      actor_user_id: string;
      actor_name: string;
      mcp_connection_id: string | null;
      prior_state: { price?: number } | null;
    }>("SELECT source, status, actor_user_id, actor_name, mcp_connection_id, prior_state FROM ai_action_audit");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("mcp");
    expect(rows[0].status).toBe("applied");
    // An automated write is never anonymous: it runs under the owner who
    // authorized the connection.
    expect(rows[0].actor_user_id).toBe(shop.userId);
    expect(rows[0].actor_name).toContain("Codex");
    expect(rows[0].mcp_connection_id).not.toBeNull();
    // Captured at execution time, which is what a one-click undo needs.
    expect(rows[0].prior_state?.price).toBe(500_000);
  });

  it("reports a refused write as a tool error rather than pretending it worked", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    const result = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: randomUUID(), price: 1 },
      }),
    ) as { isError: boolean; structuredContent: { status: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe("failed");
  });

  it("stops authenticating altogether once the authorizer's membership is gone", async () => {
    // Issue #883 P0-1: the legacy "can still read with no authorizer" fallback
    // is gone. A credential whose authorizing member has been removed has no
    // authority behind it, so it authenticates nothing — exactly like a
    // revoked connection — rather than keeping full read access.
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    await db.query("DELETE FROM users WHERE id = $1", [shop.userId]);

    const outcome = await mcpAuth.withMcpScope(bearer(token), () => Promise.resolve("reached"));
    expect(outcome.ok).toBe(false);
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("stops authenticating the moment the authorizing member is deactivated", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    await db.query("UPDATE users SET is_active = false WHERE id = $1", [shop.userId]);

    const outcome = await mcpAuth.withMcpScope(bearer(token), () => Promise.resolve("reached"));
    expect(outcome.ok).toBe(false);
  });
});

describe("writing in approve mode", () => {
  it("changes nothing, and says so instead of claiming success", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    const result = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: shop.menuItemId, price: 900_000 },
      }),
    ) as { isError: boolean; structuredContent: { status: string; message: string } };

    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe("pending_approval");
    expect(result.structuredContent.message).toContain("در انتظار تأیید");
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("shows up in the owner's approval list", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 900_000 },
    });

    const pending = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].actionType).toBe("menu.item.priceUpdate");
    expect(pending[0].connectionName).toBe("Codex");
    // The owner reads the figure that will actually be applied, not a summary
    // the model wrote.
    expect(pending[0].summary).toContain("900000");
  });

  it("applies the stored payload unchanged when a human approves", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 900_000 },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );

    const decided = await dbLib.withTenant(shop.businessId, () =>
      writeService.decideMcpPendingAction({
        businessId: shop.businessId,
        auditId: pending.id,
        decision: "approve",
        deciderUserId: shop.userId,
      }),
    );
    expect(decided).toMatchObject({ ok: true, decision: "approve" });
    expect(await priceOf(shop.menuItemId)).toBe(900_000);

    // …and it leaves the queue, so a second approval cannot double-apply it.
    const after = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    expect(after).toHaveLength(0);
  });

  it("writes nothing when a human rejects", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 900_000 },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );

    await dbLib.withTenant(shop.businessId, () =>
      writeService.decideMcpPendingAction({
        businessId: shop.businessId,
        auditId: pending.id,
        decision: "reject",
        deciderUserId: shop.userId,
      }),
    );
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
    const { rows } = await db.query<{ status: string }>("SELECT status FROM ai_action_audit");
    expect(rows[0].status).toBe("dismissed");
  });

  it("takes the write tools away the moment the owner narrows the connection", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 900_000 },
    });

    const { rows } = await db.query<{ id: string }>("SELECT id FROM mcp_connections");
    await dbLib.withTenant(shop.businessId, () =>
      connections.updateMcpConnectionAccess(shop.businessId, rows[0].id, {
        scopes: ["pos.read"],
        writeMode: "approve",
        authorizedBy: shop.userId,
      }),
    );

    const listed = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    expect(listed.tools.some((tool) => tool.name.startsWith("write_"))).toBe(false);

    // Issue #883 P0-3: the queued write does not survive the narrow — a
    // connection that may no longer write retains no approvable authority.
    const pending = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    expect(pending).toHaveLength(0);
    const { rows: audit } = await db.query<{ status: string; result: { cancelled?: string } }>(
      "SELECT status, result FROM ai_action_audit",
    );
    expect(audit[0].status).toBe("dismissed");
    expect(audit[0].result.cancelled).toBe("connection_narrowed");
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });
});

describe("the OAuth flow, end to end", () => {
  async function register() {
    return dbLib.withTenant(shop.businessId, () =>
      oauthService.registerMcpClient(shop.businessId, {
        clientName: "Claude",
        redirectUris: [REDIRECT_URI],
      }),
    );
  }

  it("registers a public client with no secret to leak", async () => {
    const result = await register();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.clientName).toBe("Claude");
    const { rows } = await db.query("SELECT * FROM mcp_oauth_clients");
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain("client_secret");
  });

  it("refuses a registration whose redirect URI is not one we would ever send a code to", async () => {
    const result = await dbLib.withTenant(shop.businessId, () =>
      oauthService.registerMcpClient(shop.businessId, {
        clientName: "Evil",
        redirectUris: ["javascript:alert(1)", "http://evil.example/cb"],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("goes register → consent → code → token → a working read connection", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");

    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: "xyz",
        requestedScopes: ["pos.read", "pos.write"],
        // The owner ticked read only.
        approvedScopes: ["pos.read"],
        writeMode: "approve",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude on my phone",
      }),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.redirectTo).toContain("state=xyz");

    const exchanged = await dbLib.withTenant(shop.businessId, () =>
      oauthService.exchangeAuthorizationCode({
        businessId: shop.businessId,
        code: issued.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId: registered.client.clientId,
      }),
    );
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    // The grant is what the owner approved, not what the client asked for.
    expect(exchanged.tokens.scopes).toEqual(["pos.read"]);

    const auth = await mcpAuth.authenticateMcp(bearer(exchanged.tokens.accessToken));
    expect(auth).toMatchObject({
      businessId: shop.businessId,
      scopes: ["pos.read"],
      connectionName: "Claude on my phone",
    });

    const listed = resultOf(await call(exchanged.tokens.accessToken, "tools/list")) as {
      tools: Array<{ name: string }>;
    };
    expect(listed.tools.some((tool) => tool.name.startsWith("write_"))).toBe(false);
  });

  it("refuses the exchange without the right PKCE verifier", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: null,
        requestedScopes: ["pos.read"],
        approvedScopes: ["pos.read"],
        writeMode: "approve",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude",
      }),
    );
    if (!issued.ok) throw new Error("issue failed");

    const exchanged = await dbLib.withTenant(shop.businessId, () =>
      oauthService.exchangeAuthorizationCode({
        businessId: shop.businessId,
        code: issued.code,
        codeVerifier: "w".repeat(64),
        redirectUri: REDIRECT_URI,
        clientId: registered.client.clientId,
      }),
    );
    expect(exchanged).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await db.query("SELECT * FROM mcp_connections").then((r) => r.rows)).toHaveLength(0);
  });

  it("spends an authorization code exactly once", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: null,
        requestedScopes: ["pos.read"],
        approvedScopes: ["pos.read"],
        writeMode: "approve",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude",
      }),
    );
    if (!issued.ok) throw new Error("issue failed");

    const exchange = () =>
      dbLib.withTenant(shop.businessId, () =>
        oauthService.exchangeAuthorizationCode({
          businessId: shop.businessId,
          code: issued.code,
          codeVerifier: VERIFIER,
          redirectUri: REDIRECT_URI,
          clientId: registered.client.clientId,
        }),
      );
    expect((await exchange()).ok).toBe(true);
    expect(await exchange()).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("rotates the refresh token and re-reads the connection's current scopes", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: null,
        requestedScopes: ["pos.read", "pos.write"],
        approvedScopes: ["pos.read", "pos.write"],
        writeMode: "apply",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude",
      }),
    );
    if (!issued.ok) throw new Error("issue failed");
    const first = await dbLib.withTenant(shop.businessId, () =>
      oauthService.exchangeAuthorizationCode({
        businessId: shop.businessId,
        code: issued.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId: registered.client.clientId,
      }),
    );
    if (!first.ok) throw new Error("exchange failed");

    // The owner narrows the connection to read-only between refreshes.
    const { rows } = await db.query<{ id: string }>("SELECT id FROM mcp_connections");
    await dbLib.withTenant(shop.businessId, () =>
      connections.updateMcpConnectionAccess(shop.businessId, rows[0].id, {
        scopes: ["pos.read"],
        writeMode: "approve",
        authorizedBy: shop.userId,
      }),
    );

    const refreshed = await dbLib.withTenant(shop.businessId, () =>
      oauthService.refreshMcpToken({
        businessId: shop.businessId,
        refreshToken: first.tokens.refreshToken,
      }),
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    // A refresh cannot restore what the owner took away.
    expect(refreshed.tokens.scopes).toEqual(["pos.read"]);
    expect(refreshed.tokens.refreshToken).not.toBe(first.tokens.refreshToken);

    // The old refresh token is dead the moment it is used — which is the only
    // thing that makes a stolen one detectable.
    const replay = await dbLib.withTenant(shop.businessId, () =>
      oauthService.refreshMcpToken({
        businessId: shop.businessId,
        refreshToken: first.tokens.refreshToken,
      }),
    );
    expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("kills every token when the connection is revoked", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: CHALLENGE,
        state: null,
        requestedScopes: ["pos.read"],
        approvedScopes: ["pos.read"],
        writeMode: "approve",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude",
      }),
    );
    if (!issued.ok) throw new Error("issue failed");
    const exchanged = await dbLib.withTenant(shop.businessId, () =>
      oauthService.exchangeAuthorizationCode({
        businessId: shop.businessId,
        code: issued.code,
        codeVerifier: VERIFIER,
        redirectUri: REDIRECT_URI,
        clientId: registered.client.clientId,
      }),
    );
    if (!exchanged.ok) throw new Error("exchange failed");

    const { rows } = await db.query<{ id: string }>("SELECT id FROM mcp_connections");
    await dbLib.withTenant(shop.businessId, () =>
      connections.revokeMcpConnection(shop.businessId, rows[0].id),
    );

    expect(await mcpAuth.authenticateMcp(bearer(exchanged.tokens.accessToken))).toBeNull();
    expect(
      await dbLib.withTenant(shop.businessId, () =>
        oauthService.refreshMcpToken({
          businessId: shop.businessId,
          refreshToken: exchanged.tokens.refreshToken,
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("never issues a code for a redirect URI the client did not register", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const issued = await dbLib.withTenant(shop.businessId, () =>
      oauthService.issueAuthorizationCode({
        businessId: shop.businessId,
        clientId: registered.client.clientId,
        redirectUri: "https://evil.example/cb",
        codeChallenge: CHALLENGE,
        state: null,
        requestedScopes: ["pos.read"],
        approvedScopes: ["pos.read"],
        writeMode: "approve",
        locationId: shop.locationId,
        userId: shop.userId,
        connectionName: "Claude",
      }),
    );
    expect(issued).toMatchObject({ ok: false, error: "invalid_redirect" });
  });

  it("refuses to authorize an unknown client without redirecting anywhere", async () => {
    // Redirecting an unregistered client IS the open redirect, so this must be
    // a page the user sees, never a bounce.
    const validation = await dbLib.withTenant(shop.businessId, () =>
      oauthService.validateAuthorizationRequest(
        shop.businessId,
        new URLSearchParams({
          response_type: "code",
          client_id: randomUUID(),
          redirect_uri: REDIRECT_URI,
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
        }),
      ),
    );
    expect(validation).toMatchObject({ ok: false, kind: "display", error: "invalid_client" });
  });

  it("refuses plain PKCE, and says so through the client's own redirect", async () => {
    const registered = await register();
    if (!registered.ok) throw new Error("registration failed");
    const validation = await dbLib.withTenant(shop.businessId, () =>
      oauthService.validateAuthorizationRequest(
        shop.businessId,
        new URLSearchParams({
          response_type: "code",
          client_id: registered.client.clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: CHALLENGE,
          code_challenge_method: "plain",
        }),
      ),
    );
    expect(validation).toMatchObject({ ok: false, kind: "redirect", error: "invalid_request" });
  });
});

// ---------------------------------------------------------------------------
// Issue #883 — the P0 blockers, reproduced and fixed.
// ---------------------------------------------------------------------------

/** A second, non-owner member — the staff role the P0-1 scenarios are about.
 *  Pinned to the shop's branch, the way a real branch employee is. */
async function addStaff(role: string, overrides?: { granted?: string[]; revoked?: string[] }) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash, permissions, location_id)
     VALUES ($1, $2, $3, $4, 'x', COALESCE($5::jsonb, '{}'::jsonb), $6) RETURNING id`,
    [
      shop.businessId,
      role,
      `کارمند ${role}`,
      `${role}-${randomUUID().slice(0, 8)}@example.test`,
      overrides ? JSON.stringify(overrides) : null,
      shop.locationId,
    ],
  );
  return rows[0].id;
}

describe("P0-1: reads respect the authorizer's CURRENT permissions", () => {
  it("a cashier-authorized connection cannot see or call the payroll tool", async () => {
    const cashierId = await addStaff("cashier");
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], userId: cashierId });

    const listed = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    const names = listed.tools.map((tool) => tool.name);
    // menuView and the floor CRM note are in the cashier preset; payroll,
    // the ledger and the report engine are not.
    expect(names).toContain("find_items");
    expect(names).not.toContain("get_payroll_summary");
    expect(names).not.toContain("get_vat_liability");
    expect(names).not.toContain("run_report");
    // …and asking for one by name anyway gets the refusal, never the data.
    const refused = await call(token, "tools/call", { name: "get_payroll_summary" });
    expect((refused as { error?: { message: string } }).error?.message).toContain("مجاز نیست");
  });

  it("the same tools/list for the owner still contains those tools — it is RBAC, not a narrower catalogue", async () => {
    const token = await mintToken({ scopes: ["pos.read"] });
    const listed = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("get_payroll_summary");
    expect(names).toContain("run_report");
    expect(names).toContain("find_customers");
  });

  it("a permission revoked mid-life is gone on the very next call", async () => {
    // A manager starts able to read CRM…
    const managerId = await addStaff("manager", { revoked: [] });
    const token = await mintToken({ scopes: ["pos.read"], userId: managerId });
    const before = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    expect(before.tools.some((tool) => tool.name === "find_customers")).toBe(true);

    // …the owner revokes crm.view from that one member…
    await db.query("UPDATE users SET permissions = $2::jsonb WHERE id = $1", [
      managerId,
      JSON.stringify({ revoked: ["crm.view"] }),
    ]);

    // …and the very next call no longer lists or answers the tool.
    const after = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    expect(after.tools.some((tool) => tool.name === "find_customers")).toBe(false);
    const refused = await call(token, "tools/call", { name: "find_customers", arguments: { query: "الف" } });
    expect((refused as { error?: { message: string } }).error?.message).toContain("مجاز نیست");
  });

  it("resources follow the same rule: no report catalogue without reports.view", async () => {
    const cashierId = await addStaff("cashier");
    const token = await mintToken({ scopes: ["pos.read"], userId: cashierId });

    const listed = resultOf(await call(token, "resources/list")) as {
      resources: Array<{ uri: string }>;
    };
    const uris = listed.resources.map((resource) => resource.uri);
    expect(uris).toContain("pos://app/conventions");
    expect(uris).not.toContain("pos://reports/catalog");

    const refused = await call(token, "resources/read", { uri: "pos://reports/catalog" });
    expect((refused as { error?: { message: string } }).error?.message).toContain("وجود ندارد");
  });
});

describe("P0-5: writes re-check the acting member's CURRENT permission", () => {
  it("an apply-mode write fails closed when the authorizer lacks the action's permission", async () => {
    // The cashier has menu.view but not menu.edit — the write tool is hidden…
    const cashierId = await addStaff("cashier");
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply", userId: cashierId });
    const listed = resultOf(await call(token, "tools/list")) as { tools: Array<{ name: string }> };
    expect(listed.tools.some((tool) => tool.name === "write_menu_item_price")).toBe(false);

    // …and a direct call is refused with nothing changed.
    const refused = await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: 700_000 },
    });
    expect((refused as { error?: { message: string } }).error?.message).toContain("مجاز نیست");
    expect(await priceOf(shop.menuItemId)).toBe(500_000);
  });

  it("a permission granted later takes effect on the very next write — no re-consent needed", async () => {
    const cashierId = await addStaff("cashier", { granted: ["menu.edit"] });
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply", userId: cashierId });

    const result = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: shop.menuItemId, price: 700_000 },
      }),
    ) as { structuredContent: { status: string } };
    expect(result.structuredContent.status).toBe("applied");
    expect(await priceOf(shop.menuItemId)).toBe(700_000);
  });
});

describe("P0-2: a connection never writes across its own branch", () => {
  it("an apply-mode write naming another branch's item is refused", async () => {
    const { rows: otherLocation } = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دوم') RETURNING id",
      [shop.businessId],
    );
    const { rows: cat } = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی') RETURNING id",
      [otherLocation[0].id],
    );
    const { rows: otherItem } = await db.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, price)
       VALUES ($1, $2, 'چای', 300000) RETURNING id`,
      [otherLocation[0].id, cat[0].id],
    );

    // The connection is minted on branch ONE (shop.locationId) and the model
    // was handed an id belonging to branch TWO — tampering, or an id that
    // leaked through find_items on a stale connection. Either way: refused.
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    const result = resultOf(
      await call(token, "tools/call", {
        name: "write_menu_item_price",
        arguments: { menuItemId: otherItem[0].id, price: 700_000 },
      }),
    ) as { structuredContent: { status: string; error: string } };
    expect(result.structuredContent.status).toBe("failed");
    expect(result.structuredContent.error).toBe("branch_forbidden");

    const { rows: price } = await db.query<{ price: string }>(
      "SELECT price FROM menu_items WHERE id = $1",
      [otherItem[0].id],
    );
    expect(Number(price[0].price)).toBe(300_000);
  });
});

describe("P0-3: no duplicate or stale executions", () => {
  async function proposePrice(amount: number) {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "approve" });
    await call(token, "tools/call", {
      name: "write_menu_item_price",
      arguments: { menuItemId: shop.menuItemId, price: amount },
    });
    const [pending] = await dbLib.withTenant(shop.businessId, () =>
      connections.listMcpPendingActions(shop.businessId),
    );
    return pending.id;
  }

  function decide(auditId: string) {
    return dbLib.withTenant(shop.businessId, () =>
      writeService.decideMcpPendingAction({
        businessId: shop.businessId,
        auditId,
        decision: "approve",
        deciderUserId: shop.userId,
      }),
    );
  }

  it("two parallel approvals execute the side effect exactly once", async () => {
    const auditId = await proposePrice(900_000);
    const [first, second] = await Promise.all([decide(auditId), decide(auditId)]);

    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, error: "not_found" });
    expect(await priceOf(shop.menuItemId)).toBe(900_000);

    const { rows } = await db.query<{ status: string }>("SELECT status FROM ai_action_audit");
    expect(rows.map((r) => r.status)).toEqual(["applied"]);
  });

  it("a retried apply with the same idempotency key applies once and returns the original outcome", async () => {
    const token = await mintToken({ scopes: ["pos.read", "pos.write"], writeMode: "apply" });
    const invoke = async () =>
      resultOf(
        await call(token, "tools/call", {
          name: "write_menu_item_price",
          arguments: { menuItemId: shop.menuItemId, price: 800_000 },
          _meta: { idempotencyKey: "retry-42" },
        }),
      ) as { structuredContent: { status: string; auditId: string } };

    const first = await invoke();
    const second = await invoke();
    expect(first.structuredContent.status).toBe("applied");
    expect(second.structuredContent.status).toBe("applied");
    // Same audit row — the retry read the durable outcome, no second effect.
    expect(second.structuredContent.auditId).toBe(first.structuredContent.auditId);

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ai_action_audit WHERE mcp_idempotency_key = 'retry-42'",
    );
    expect(Number(rows[0].count)).toBe(1);
    expect(await priceOf(shop.menuItemId)).toBe(800_000);
  });

  it("a revoked connection's queued writes are cancelled, not approvable", async () => {
    const auditId = await proposePrice(900_000);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM mcp_connections");
    await dbLib.withTenant(shop.businessId, () =>
      connections.revokeMcpConnection(shop.businessId, rows[0].id),
    );

    const decided = await decide(auditId);
    expect(decided).toMatchObject({ ok: false, error: "not_found" });
    expect(await priceOf(shop.menuItemId)).toBe(500_000);

    const { rows: audit } = await db.query<{ status: string; result: { cancelled?: string } }>(
      "SELECT status, result FROM ai_action_audit WHERE id = $1",
      [auditId],
    );
    expect(audit[0].status).toBe("dismissed");
    expect(audit[0].result.cancelled).toBe("connection_revoked");
  });
});
