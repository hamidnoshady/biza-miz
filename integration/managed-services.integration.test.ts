/**
 * Issue #902 §9 item 5 — the contract, against real configuration.
 *
 * The unit suite proves the translation tables. This file proves the thing a
 * table cannot: that a business asking "is this working?" gets an answer built
 * from the platform's actual singletons, that the answer follows the deployment
 * from broken to ready, and that it never carries a supplier detail even with a
 * supplier credential configured.
 *
 * The interesting assertion is the *order* one. A fresh deployment has three
 * services down at once, and all three must say "the platform has not finished
 * setting this up" rather than "check your plan" — because the tenant's plan
 * cannot fix our missing credential, and telling them otherwise is how a support
 * queue fills with people who already paid.
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

let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/managed-services/readiness-service");
let contract: typeof import("../src/lib/managed-services/contract");
let inventory: typeof import("../src/lib/managed-services/inventory");

const alpha = { businessId: "" };
const beta = { businessId: "" };

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

async function seedBusiness(name: string): Promise<{ businessId: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id };
}

/** The views as the route serves them, under a real tenant scope. */
async function views(businessId: string) {
  return dbLib.withTenant(businessId, () => service.getTenantManagedServices(businessId));
}

function byKey(list: { service: string }[], key: string) {
  const found = list.find((view) => view.service === key);
  if (!found) throw new Error(`${key} was not in the payload`);
  return found as { service: string; status: string; detail: string; action?: { href?: string } | null };
}

/**
 * The sentence a service carries when *our* setup is what is missing.
 *
 * Copied from the contract at runtime rather than transcribed: the point of the
 * assertion is that the payload is NOT this sentence, and a hard-coded copy would
 * stop testing anything the day the copy changes.
 */
function setupIncomplete(): string {
  return contract.MANAGED_SERVICE_DETAILS.platform_setup_incomplete;
}

beforeAll(async () => {
  databaseName = `pos_managed_services_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/managed-services/readiness-service");
  contract = await import("../src/lib/managed-services/contract");
  inventory = await import("../src/lib/managed-services/inventory");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

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
  await db.query("DELETE FROM kavenegar_business_accounts");
  await db.query("DELETE FROM businesses");

  // The deployment's own state, put back to "nothing is configured": every
  // service-down assertion below starts from here so the transitions it measures
  // are real.
  await db.query(
    `UPDATE platform_ai_gateway
        SET enabled = false, base_url = '', chat_model = '', master_key_ciphertext = NULL`,
  );
  await db.query(
    `UPDATE platform_payment_config
        SET gateway = 'manual', merchant_id = '', callback_url = ''`,
  );
  await db.query(
    `UPDATE platform_media_config
        SET enabled = false, endpoint = '', bucket = '', access_key_id = '', secret_access_key = ''`,
  );

  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
});

describe("one view per managed service", () => {
  it("returns every registered service exactly once", async () => {
    const list = await views(alpha.businessId);
    const registered = Object.values(contract.MANAGED_SERVICES).map((definition) => definition.key);
    expect(list.map((view) => view.service).sort()).toEqual([...registered].sort());
    expect(new Set(list.map((view) => view.service)).size).toBe(list.length);
    for (const view of list) {
      expect(Number.isNaN(Date.parse(view.checkedAt ?? ""))).toBe(false);
    }
  });

  it("passes the leak guard with the deployment fully configured", async () => {
    // Everything set up, credentials included: the payload must not grow a field
    // just because the platform has values to carry.
    await db.query(
      `UPDATE platform_payment_config
          SET gateway = 'zarinpal', merchant_id = 'merchant-1234', callback_url = 'https://example.test/cb'`,
    );
    await db.query(
      `UPDATE platform_media_config
          SET enabled = true, endpoint = 'https://storage.example.test', bucket = 'media',
              access_key_id = 'access-key-id-value', secret_access_key = 'secret-key-value-0123456789abcdef'`,
    );
    await db.query(
      `INSERT INTO kavenegar_business_accounts (business_id, localid, username, provision_state)
       VALUES ($1, $1::text, 'alpha-user', 'active')`,
      [alpha.businessId],
    );

    const list = await views(alpha.businessId);
    expect(contract.findTenantLeaks({ services: list })).toEqual([]);
    expect(() => contract.assertTenantSafePayload({ services: list })).not.toThrow();
  });
});

describe("a fresh deployment says whose side is missing", () => {
  it("reports platform setup, not the tenant's plan, for all three integrations", async () => {
    const list = await views(alpha.businessId);

    // Payments: manual transfer is a valid mode, but "online payment" is not it.
    expect(byKey(list, "payments.gateway").status).toBe("unavailable");
    expect(byKey(list, "payments.gateway").detail).toBe(setupIncomplete());
    expect(byKey(list, "media.storage").status).toBe("unavailable");
    expect(byKey(list, "media.storage").detail).toBe(setupIncomplete());
    // AI: the platform switch is off, which is ours, not a plan problem.
    expect(byKey(list, "ai.assistant").status).toBe("unavailable");

    // None of them blames the business for our setup.
    for (const key of ["ai.assistant", "payments.gateway", "media.storage"]) {
      expect(byKey(list, key).status).not.toBe("action_required");
    }
  });

  it("has not provisioned an SMS account yet, so SMS is preparing", async () => {
    const list = await views(alpha.businessId);
    const sms = byKey(list, "messaging.sms");
    expect(sms.status).toBe("preparing");
    expect(sms.detail).toContain("آماده‌سازی");
  });
});

describe("configuring the platform moves each service forward", () => {
  it("media goes from our setup to their plan", async () => {
    await db.query(
      `UPDATE platform_media_config
          SET enabled = true, endpoint = 'https://storage.example.test', bucket = 'media',
              access_key_id = 'key', secret_access_key = 'secret'`,
    );
    const media = byKey(await views(alpha.businessId), "media.storage");
    // Configured, so the remaining question is commercial — never "we are still
    // setting it up". Whether it lands on `ready` or on a plan state depends on
    // the seeded plan, which is the next slice's subject, not this one's.
    expect(media.detail).not.toBe(setupIncomplete());
  });

  it("online payment goes from our setup to their plan", async () => {
    await db.query(
      `UPDATE platform_payment_config
          SET gateway = 'zarinpal', merchant_id = 'merchant-1234', callback_url = 'https://example.test/cb'`,
    );
    const payments = byKey(await views(alpha.businessId), "payments.gateway");
    expect(payments.detail).not.toBe(setupIncomplete());
  });

  it("switching AI on without a usable credential is not 'ready'", async () => {
    await db.query(
      `UPDATE platform_ai_gateway
          SET enabled = true, base_url = 'https://ai-gateway.example.test', chat_model = 'model-a'`,
    );
    const ai = byKey(await views(alpha.businessId), "ai.assistant");
    // The runtime has no credential it can use, so the honest state is still
    // ours to fix — a switch flipped in the console is not a working service.
    expect(ai.status).toBe("unavailable");
    expect(ai.detail).toBe(setupIncomplete());
  });
});

describe("SMS readiness follows the business's own account", () => {
  it("is ready only for the business whose child account is active", async () => {
    await db.query(
      `INSERT INTO kavenegar_business_accounts (business_id, localid, username, provision_state)
       VALUES ($1, $1::text, 'alpha-user', 'active')`,
      [alpha.businessId],
    );

    const [alphaList, betaList] = await Promise.all([
      views(alpha.businessId),
      views(beta.businessId),
    ]);
    expect(byKey(alphaList, "messaging.sms").status).toBe("ready");
    // The other business still sees its own, unprovisioned state.
    expect(byKey(betaList, "messaging.sms").status).toBe("preparing");
  });

  it("reports a suspended account as a plan-level stop", async () => {
    await db.query(
      `INSERT INTO kavenegar_business_accounts (business_id, localid, username, provision_state)
       VALUES ($1, $1::text, 'alpha-user', 'suspended')`,
      [alpha.businessId],
    );
    const sms = byKey(await views(alpha.businessId), "messaging.sms");
    expect(sms.status).toBe("action_required");
    expect(sms.action?.href).toBe("/settings/billing");
  });
});

describe("the inventory and the payload agree", () => {
  it("serves exactly the services the inventory says exist", async () => {
    const list = await views(alpha.businessId);
    for (const view of list) {
      expect(inventory.managedInventoryEntry(view.service), view.service).toBeDefined();
    }
  });
});
