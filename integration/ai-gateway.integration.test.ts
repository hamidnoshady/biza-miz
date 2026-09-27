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

    const withKey = { ...row, virtualKey: "sk-tenant" };
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
