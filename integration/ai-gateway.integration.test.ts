/**
 * Phase 37 & Phase 39 — the gateway's database half, against a real Postgres.
 *
 * Covers gateway singleton round-trips, business gateway rows,
 * and the Phase 39 branch layer (location_id key rows and isolation).
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

let gateway: typeof import("../src/lib/ai-gateway-service");
let pagination: typeof import("../src/lib/platform-ai-gateway-pagination");
let dbLib: typeof import("../src/lib/db");

let rlsActive = false;

const alpha = { businessId: "", location1Id: "", location2Id: "" };
const beta = { businessId: "", location1Id: "" };

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

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeAll(async () => {
  databaseName = `pos_ai_gw_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  gateway = await import("../src/lib/ai-gateway-service");
  pagination = await import("../src/lib/platform-ai-gateway-pagination");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  rlsActive = await dbLib.rlsEffective();
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

beforeEach(async () => {
  await db.query("DELETE FROM ai_gateway_usage");
  await db.query("DELETE FROM ai_business_gateway");
  await db.query("DELETE FROM platform_ai_gateway");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRows = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1), ('Beta', $2) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`, `beta-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = bizRows.rows[0].id;
  beta.businessId = bizRows.rows[1].id;

  const locRows = await db.query<{ id: string; business_id: string }>(
    `INSERT INTO locations (business_id, name) VALUES
      ($1, 'Alpha Branch 1'),
      ($1, 'Alpha Branch 2'),
      ($2, 'Beta Branch 1')
     RETURNING id, business_id`,
    [alpha.businessId, beta.businessId],
  );
  alpha.location1Id = locRows.rows[0].id;
  alpha.location2Id = locRows.rows[1].id;
  beta.location1Id = locRows.rows[2].id;
});

describe("the gateway singleton", () => {
  it("returns a switched-off default before anything is stored", async () => {
    const config = await gateway.getAiGatewayConfig();
    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe("http://litellm:4000/v1");
    expect(JSON.stringify(config)).not.toMatch(/fallbackModels|publishedModels|allowBusinessModels|mcpServers|mcpEnabled/);
  });

  it("round-trips technical aliases and retires app-owned routing/model mirrors", async () => {
    const saved = await gateway.saveAiGatewayConfig({
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      embeddingModel: "pos-embed",
    });
    expect(saved.enabled).toBe(true);
    expect(saved.chatModel).toBe("pos-chat");
    expect(saved.embeddingModel).toBe("pos-embed");
    // Migration 0168 & issue #748 P2-7: the stored config carries no routing/model/budget/limit
    // mirror any more — those live in LiteLLM and Plan/Billing.
    expect(JSON.stringify(saved)).not.toMatch(/routingStrategy|maxBudgetUsd|tpmLimit|rpmLimit|budgetDuration/);

    const reread = await gateway.getAiGatewayConfig();
    expect(reread).toEqual(saved);
  });

  it("keeps the stored master key when the form leaves it blank", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", masterKey: "sk-first" });
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", chatModel: "pos-chat" });
    expect((await gateway.getAiGatewayConfig()).masterKey).toBe("sk-first");
  });

  it("never exposes the master key in the public shape", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", masterKey: "sk-secret" });
    const pub = gateway.toPublicAiGatewayConfig(await gateway.getAiGatewayConfig());
    expect(pub.hasMasterKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("stores no budget or rate-limit defaults at all — the wallet is the single stop", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", chatModel: "pos-chat" });
    const stored = await gateway.getAiGatewayConfig();
    expect(JSON.stringify(stored)).not.toMatch(/defaultMaxBudgetUsd|defaultTpmLimit|defaultRpmLimit|defaultBudgetDuration|routingStrategy/);
  });
});

describe("one business's gateway row", () => {
  function getTestConfig() {
    return {
      ...gateway.defaultGatewayConfig(),
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      virtualKeysEnabled: true,
      masterKey: "sk-master",
    };
  }

  it("starts absent, which means the shared connection is used", async () => {
    expect(await asBusiness(alpha.businessId, () => gateway.getBusinessGateway(alpha.businessId))).toBeNull();
  });

  it("creates an identity-only row carrying no model, budget or rate-limit fields", async () => {
    const row = await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId));
    expect(row.businessId).toBe(alpha.businessId);
    expect(row.virtualKey).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/modelOverride|maxBudgetUsd|tpmLimit|rpmLimit|budgetDuration/);
  });

  it.skipIf(!rlsActive)("keeps one business's row out of another business's session", async () => {
    await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId));

    expect(await asBusiness(beta.businessId, () => gateway.getBusinessGateway(alpha.businessId))).toBeNull();
    await expect(
      asBusiness(beta.businessId, () => gateway.saveBusinessGateway(alpha.businessId)),
    ).rejects.toThrow();
  });

  it("confines a business's own row to that business, whatever the role", async () => {
    await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId));
    await asBusiness(beta.businessId, () => gateway.saveBusinessGateway(beta.businessId));

    const alphaRow = await asBusiness(alpha.businessId, () => gateway.getBusinessGateway(alpha.businessId));
    const betaRow = await asBusiness(beta.businessId, () => gateway.getBusinessGateway(beta.businessId));
    expect(alphaRow?.businessId).toBe(alpha.businessId);
    expect(betaRow?.businessId).toBe(beta.businessId);
    // Identity-only rows: no mirrored models, key budgets or rate limits remain.
    expect(JSON.stringify(betaRow)).not.toMatch(/maxBudgetUsd|tpmLimit|rpmLimit|budgetDuration|modelOverride/);
  });

  it("lists every business's row for the platform console", async () => {
    await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId));
    await asBusiness(beta.businessId, () => gateway.saveBusinessGateway(beta.businessId));

    const rows = await gateway.listBusinessGateways();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.businessId).sort()).toEqual([alpha.businessId, beta.businessId].sort());
  });

  it("reports the model a call would actually use", async () => {
    const config = getTestConfig();
    const row = await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId));
    expect(gateway.toPublicBusinessGateway(row, config, "gpt-4o-mini").effectiveModel).toBe("pos-chat");

    const withKey = { ...row, virtualKey: "sk-tenant", credentialState: "present" as const };
    const pub = gateway.toPublicBusinessGateway(withKey, config, "gpt-4o-mini");
    expect(pub.hasVirtualKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-tenant");
    expect(JSON.stringify(pub)).not.toContain("modelOverride");
    expect(JSON.stringify(pub)).not.toContain("spendUsd");
  });
});

describe("Phase 39 branch layer", () => {
  function getTestConfig() {
    return {
      ...gateway.defaultGatewayConfig(),
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      virtualKeysEnabled: true,
      masterKey: "sk-master",
    };
  }

  it("keeps branch rows separate, identity-only", async () => {
    // Business-level key row.
    await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId, null));

    // Branch-level key row.
    await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId, alpha.location1Id));

    const bizRow = await asBusiness(alpha.businessId, () => gateway.getBusinessGateway(alpha.businessId, null));
    const branch1Row = await asBusiness(alpha.businessId, () =>
      gateway.getBranchGateway(alpha.businessId, alpha.location1Id),
    );
    const branch2Row = await asBusiness(alpha.businessId, () =>
      gateway.getBranchGateway(alpha.businessId, alpha.location2Id),
    );

    expect(bizRow?.locationId).toBeNull();
    expect(branch1Row?.locationId).toBe(alpha.location1Id);
    expect(branch2Row).toBeNull(); // Branch 2 has no row

    const branches = await asBusiness(alpha.businessId, () => gateway.listBranchGateways(alpha.businessId));
    expect(branches).toHaveLength(1);
    expect(branches[0].locationId).toBe(alpha.location1Id);
  });

  it("correctly resolves effective models: gateway alias -> platform default", async () => {
    const config = getTestConfig();
    const bizRow = await asBusiness(alpha.businessId, () => gateway.saveBusinessGateway(alpha.businessId, null));
    const branch1Row = await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, alpha.location1Id),
    );

    // Branch and business rows both use the LiteLLM alias; row-level model
    // overrides are no longer part of the app-owned gateway contract.
    const pubBranch1 = gateway.toPublicBusinessGateway(branch1Row, config, "gpt-4o-mini");
    expect(pubBranch1.effectiveModel).toBe("pos-chat");

    const pubBiz = gateway.toPublicBusinessGateway(bizRow, config, "gpt-4o-mini");
    expect(pubBiz.effectiveModel).toBe("pos-chat");
  });
});

describe("platform AI gateway pagination against PostgreSQL", () => {
  const fleetDefaults: import("../src/lib/platform-ai-gateway-pagination").FleetPaginationInput = {
    gatewayVirtualKeysEnabled: false,
    gatewayUnavailable: false,
    masterKeyConfigured: true,
    searchPattern: "",
    statusFilter: "all",
    focusBusinessId: "",
    pageSize: 2,
    requestedPage: 1,
  };

  function fleetPage(
    overrides: Partial<import("../src/lib/platform-ai-gateway-pagination").FleetPaginationInput> = {},
  ) {
    return pagination.listAiGatewayFleetPage({ ...fleetDefaults, ...overrides });
  }

  function businessIds(rows: Array<{ business_id: string | null }>): string[] {
    return rows.flatMap((row) => (row.business_id ? [row.business_id] : []));
  }

  it("executes first, middle, last and beyond-last fleet pages with deterministic ordering", async () => {
    await db.query(
      "INSERT INTO businesses (name, slug) VALUES ('Gamma', $1), ('Delta', $2), ('Epsilon', $3)",
      [`gamma-${randomUUID().slice(0, 8)}`, `delta-${randomUUID().slice(0, 8)}`, `epsilon-${randomUUID().slice(0, 8)}`],
    );

    const first = await fleetPage({ pageSize: 2, requestedPage: 1 });
    const middle = await fleetPage({ pageSize: 2, requestedPage: 2 });
    const last = await fleetPage({ pageSize: 2, requestedPage: 3 });
    const beyondLast = await fleetPage({ pageSize: 2, requestedPage: 2_147_483_647 });

    expect(first.rows.map((row) => row.business_name)).toEqual(["Alpha", "Beta"]);
    expect(middle.rows.map((row) => row.business_name)).toEqual(["Delta", "Epsilon"]);
    expect(last.rows.map((row) => row.business_name)).toEqual(["Gamma"]);
    expect(beyondLast.rows.map((row) => row.business_name)).toEqual(["Gamma"]);
    expect(first.rows[0]).toMatchObject({ total: 5, total_pages: 3, page: 1 });
    expect(middle.rows[0]).toMatchObject({ total: 5, total_pages: 3, page: 2 });
    expect(last.rows[0]).toMatchObject({ total: 5, total_pages: 3, page: 3 });
    expect(beyondLast.rows[0]).toMatchObject({ total: 5, total_pages: 3, page: 3 });
  });

  it("returns a stable empty page and applies search and status filters in PostgreSQL", async () => {
    await db.query("UPDATE feature_flags SET default_enabled = true WHERE key = 'ai_assistant'");
    await db.query(
      "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ai_assistant', false)",
      [beta.businessId],
    );

    const search = await fleetPage({ searchPattern: "%Alpha%", pageSize: 1 });
    expect(search.rows.map((row) => row.business_name)).toEqual(["Alpha"]);
    expect(search.rows[0]).toMatchObject({ total: 1, total_pages: 1, page: 1 });

    const disabled = await fleetPage({ statusFilter: "entitlement_disabled", pageSize: 10 });
    expect(disabled.rows.map((row) => row.business_name)).toEqual(["Beta"]);
    expect(disabled.rows[0]).toMatchObject({ fleet_status: "entitlement_disabled" });

    const empty = await fleetPage({ searchPattern: "%does-not-exist%", pageSize: 2, requestedPage: 99 });
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0]).toMatchObject({ total: 0, total_pages: 1, page: 1, business_id: null });
  });

  it("keeps a focused business and focused location visible outside their requested pages", async () => {
    const focused = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Zulu Focus', $1) RETURNING id",
      [`zulu-${randomUUID().slice(0, 8)}`],
    );
    const focusedBusinessId = focused.rows[0].id;
    const locations = await db.query<{ id: string; name: string }>(
      `INSERT INTO locations (business_id, name) VALUES
        ($1, 'Focus Branch A'), ($1, 'Focus Branch B'), ($1, 'Focus Branch Z')
       RETURNING id, name`,
      [focusedBusinessId],
    );
    const focusedLocationId = locations.rows.find((row) => row.name === "Focus Branch Z")!.id;

    const firstLocationPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: "",
      pageSize: 1,
      requestedPage: 1,
    });
    const middleLocationPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: "",
      pageSize: 1,
      requestedPage: 2,
    });
    const lastLocationPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: "",
      pageSize: 1,
      requestedPage: 3,
    });
    const beyondLocationPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: "",
      pageSize: 1,
      requestedPage: 2_147_483_647,
    });
    expect(firstLocationPage.rows.map((row) => row.name)).toEqual(["Focus Branch A"]);
    expect(middleLocationPage.rows.map((row) => row.name)).toEqual(["Focus Branch B"]);
    expect(lastLocationPage.rows.map((row) => row.name)).toEqual(["Focus Branch Z"]);
    expect(beyondLocationPage.rows.map((row) => row.name)).toEqual(["Focus Branch Z"]);
    expect(beyondLocationPage.rows[0]).toMatchObject({ total: 3, total_pages: 3, page: 3 });
    const locationSearch = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "%Branch B%",
      focusLocationId: "",
      pageSize: 10,
      requestedPage: 1,
    });
    expect(locationSearch.rows.map((row) => row.name)).toEqual(["Focus Branch B"]);
    const emptyLocationPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "%missing%",
      focusLocationId: "",
      pageSize: 2,
      requestedPage: 99,
    });
    expect(emptyLocationPage.rows).toHaveLength(1);
    expect(emptyLocationPage.rows[0]).toMatchObject({ total: 0, total_pages: 1, page: 1, id: null });

    const fleet = await fleetPage({
      pageSize: 1,
      requestedPage: 1,
      focusBusinessId: focusedBusinessId,
    });
    expect(fleet.rows.map((row) => row.business_name)).toEqual(["Alpha", "Zulu Focus"]);
    expect(fleet.rows.find((row) => row.business_id === focusedBusinessId)?.is_focused).toBe(true);

    const locationsPage = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: focusedLocationId,
      pageSize: 1,
      requestedPage: 1,
    });
    expect(locationsPage.rows.map((row) => row.name)).toEqual(["Focus Branch A", "Focus Branch Z"]);
    expect(locationsPage.rows.every((row) => row.business_id === focusedBusinessId)).toBe(true);

    // A location id from another tenant cannot be pulled into the focused
    // business's result, even though the platform query deliberately bypasses
    // tenant RLS for the authenticated console.
    const foreignLocation = await pagination.listAiGatewayLocationPage({
      businessId: focusedBusinessId,
      searchPattern: "",
      focusLocationId: beta.location1Id,
      pageSize: 10,
      requestedPage: 1,
    });
    expect(foreignLocation.rows.map((row) => row.id)).not.toContain(beta.location1Id);
  });

  it.skipIf(!rlsActive)("keeps tenant reads isolated while the explicit platform read spans tenants", async () => {
    const tenantRows = await asBusiness(alpha.businessId, () =>
      dbLib.query<{ id: string }>("SELECT id FROM businesses ORDER BY name"),
    );
    expect(tenantRows.rows.map((row) => row.id)).toEqual([alpha.businessId]);

    const platformRows = await fleetPage({ pageSize: 10 });
    expect(businessIds(platformRows.rows)).toEqual([alpha.businessId, beta.businessId]);
  });
});
