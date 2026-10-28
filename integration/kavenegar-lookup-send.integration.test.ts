/**
 * Issue #902 §5 acceptance — sending one approved lookup message.
 *
 * What this file proves, in the issue's own terms:
 *   1. Only an **approved** template sends; a draft, a submitted or a rejected
 *      one is refused before any request leaves the building (the provider's own
 *      rule, enforced here so an operator sees it in the console).
 *   2. The send uses the **child's** key, so the message leaves the business's
 *      account — and a business with no active child is refused, never silently
 *      sent on the platform key.
 *   3. Money moves once: retail is reserved, the provider's reported cost is
 *      recorded separately as a **tenant-invisible** vendor event, and the wallet
 *      settles exactly once.
 *   4. A definitive provider refusal refunds in full.
 *   5. An **ambiguous** transport failure keeps the reservation (`unknown`): the
 *      message may have been sent, so refunding would make it free to send twice.
 *
 * No network call is made: the executor is injected and every reply is a
 * recorded fixture from the provider's documentation.
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
let lookups: typeof import("../src/lib/kavenegar/lookup-send-service");
let rest: typeof import("../src/lib/kavenegar/rest");
let credentials: typeof import("../src/lib/kavenegar/credentials");

const alpha = { businessId: "", slug: "" };
const CHILD_KEY = "CHILDKEY1234567890ABCDEFGHIJ";

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

async function seedBusiness(name: string): Promise<{ businessId: string; slug: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id, slug };
}

/** A funded wallet: one top-up row, so the balance is the ledger's own sum. */
async function fundWallet(businessId: string, rial: number): Promise<void> {
  await db.query(
    `INSERT INTO business_wallets (business_id, balance_rial, total_topped_up_rial, total_spent_rial)
     VALUES ($1, $2, $2, 0)`,
    [businessId, rial],
  );
  await db.query(
    `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, note)
     VALUES ($1, 'top_up', 'credit', $2, $2, 'seed top-up')`,
    [businessId, rial],
  );
}

/** An active child account with a decryptable key, the way provisioning leaves it. */
async function activateChild(businessId: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO kavenegar_business_accounts
       (business_id, localid, username, provision_state, provider_status, sender_lines, provisioned_at)
     VALUES ($1::uuid, $2, $3, 'active', 'approved', '{10004346}', now())
     RETURNING id`,
    [businessId, businessId, `bm${randomUUID().replaceAll("-", "").slice(0, 8)}`],
  );
  await credentials.writeAccountApiKey(rows[0]!.id, CHILD_KEY);
}

/**
 * A lookup template, written as the approval path would leave it.
 *
 * `variables` is what makes it sendable: the positional mapping from domain
 * values to `%token`/`%token2`.
 */
async function approvedTemplate(
  businessId: string,
  overrides: Partial<{ state: string; variables: string[]; archived: boolean }> = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO kavenegar_lookup_templates
       (business_id, name, title, body, purpose, state, variables, provider_template_id,
        decided_at, archived_at)
     VALUES ($1, $2, 'کد ورود', 'کد ورود شما: %token', 'verification', $3, $4, 9001, now(), $5)
     RETURNING id`,
    [
      businessId,
      `bm${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      overrides.state ?? "approved",
      overrides.variables ?? ["code"],
      overrides.archived ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

function ok(cost = "150") {
  return { messageId: "1234567", costRial: Number(cost), status: 5 };
}

async function balanceOf(businessId: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
       FROM wallet_ledger WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]?.balance ?? 0);
}

beforeAll(async () => {
  databaseName = `pos_kavenegar_send_${randomUUID().replaceAll("-", "")}`;

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
  lookups = await import("../src/lib/kavenegar/lookup-send-service");
  rest = await import("../src/lib/kavenegar/rest");
  credentials = await import("../src/lib/kavenegar/credentials");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The retail engine reads central Billing's base rate from the platform's
  // message config. Seed it at 1,200 rial per segment — a real rate, so the
  // reserve/settle assertions are about money rather than about zero.
  await db.query(
    `INSERT INTO platform_message_config (id, enabled, sms_provider, email_provider, sms_rial_per_segment)
     VALUES (true, true, 'noop', 'noop', 1200)
     ON CONFLICT (id) DO UPDATE
       SET sms_rial_per_segment = 1200, enabled = true, sms_provider = 'noop', email_provider = 'noop'`,
  );
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
  await db.query("DELETE FROM kavenegar_lookup_templates");
  await db.query("DELETE FROM kavenegar_business_accounts");
  await db.query("DELETE FROM wallet_ledger");
  await db.query("DELETE FROM business_wallets");
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  await fundWallet(alpha.businessId, 500_000);
});

describe("refusals happen before anything is sent or charged", () => {
  it("refuses a template that is not approved", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId, { state: "draft" });

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "09121234567",
      execute: async () => {
        throw new Error("the provider must not be called");
      },
    });
    expect(outcome).toEqual({ status: "blocked", code: "template_not_approved" });
    expect(await balanceOf(alpha.businessId)).toBe(500_000);
  });

  it("refuses a template with no declared variable mapping", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId, { variables: [] });

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "09121234567",
    });
    expect(outcome).toEqual({ status: "blocked", code: "template_variables_undeclared" });
  });

  it("refuses a receptor that is not a mobile number", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId);

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "02112345678",
    });
    expect(outcome).toEqual({ status: "blocked", code: "invalid_receptor" });
  });

  it("refuses to send when the business has no active child account", async () => {
    // No account row at all: the managed path cannot fall back to the platform
    // key, because that would bill the platform for a tenant's message.
    const templateId = await approvedTemplate(alpha.businessId);
    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "09121234567",
    });
    expect(outcome).toEqual({ status: "blocked", code: "sms_not_ready" });
  });

  it("refuses a variable value that would break the sentence", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId);

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "12ab" },
      receptor: "09121234567",
    });
    expect(outcome).toEqual({ status: "blocked", code: "variable_invalid", variable: "code" });
  });
});

describe("a successful send moves money exactly once", () => {
  it("charges retail, records the wholesale cost as tenant-invisible, and sends on the child key", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId);
    const calls: { apiKey: string; template: string; tokens: string[]; receptor: string }[] = [];

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "+989121234567",
      execute: async (input) => {
        calls.push(input);
        return ok("150");
      },
    });

    expect(outcome.status).toBe("sent");
    if (outcome.status !== "sent") throw new Error("unreachable");
    expect(outcome).toMatchObject({
      templateId,
      messageId: "1234567",
      segments: 1,
      providerCostRial: 150,
    });
    expect(outcome.chargedRial).toBeGreaterThan(0);

    // The child's key, not the master's; the derived provider name; the rendered
    // token; and the normalised receptor.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      apiKey: CHILD_KEY,
      receptor: "09121234567",
      tokens: ["482913"],
    });
    expect(calls[0]!.template).toMatch(/^bm[0-9a-f]{8}$/);

    // One reserve, one settle, no refund.
    const ledger = await db.query<{ kind: string; direction: string; amount_rial: string }>(
      `SELECT kind, direction, amount_rial::text FROM wallet_ledger
        WHERE business_id = $1 ORDER BY created_at`,
      [alpha.businessId],
    );
    const charged = ledger.rows.filter((row) => row.kind === "feature_charge");
    expect(charged).toHaveLength(1);
    expect(Number(charged[0]!.amount_rial)).toBe(outcome.chargedRial);
    expect(ledger.rows.some((row) => row.kind === "refund")).toBe(false);

    // The provider's cost is finance evidence, and a tenant connection cannot
    // read it (§0 / DoD #3).
    const vendor = await db.query<{ amount_rial: string; tenant_visible: boolean; provider: string }>(
      `SELECT amount_rial::text, tenant_visible, provider FROM billing_vendor_cost_events
        WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(vendor.rowCount).toBe(1);
    expect(vendor.rows[0]).toMatchObject({ amount_rial: "150", tenant_visible: false, provider: "kavenegar" });
  });
});

describe("failures reconcile instead of double-spending", () => {
  it("refunds in full when the provider definitively refuses", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId);
    const before = await balanceOf(alpha.businessId);

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "09121234567",
      execute: async () => {
        // 424 — the child's template is missing or not approved there.
        throw new rest.KavenegarManagementError({
          classification: {
            ok: false,
            retryable: false,
            code: "template_unavailable",
            fault: "provider_rejected",
            operatorMessage: "provider: template missing or not approved",
          },
          operatorUrl: "https://api.kavenegar.com/v1/***/verify/lookup.json",
          providerMessage: "template not found",
          providerStatus: 424,
        });
      },
    });

    expect(outcome).toMatchObject({ status: "failed", templateId, code: "template_unavailable" });
    expect(await balanceOf(alpha.businessId)).toBe(before);
  });

  it("keeps the reservation when the outcome is ambiguous", async () => {
    await activateChild(alpha.businessId);
    const templateId = await approvedTemplate(alpha.businessId);
    const before = await balanceOf(alpha.businessId);

    const outcome = await lookups.sendManagedLookup({
      businessId: alpha.businessId,
      templateId,
      variables: { code: "482913" },
      receptor: "09121234567",
      execute: async () => {
        throw new rest.KavenegarTransportError("provider request timed out", {
          ambiguous: true,
          timeout: true,
        });
      },
    });

    expect(outcome.status).toBe("unknown");
    if (outcome.status !== "unknown") throw new Error("unreachable");
    // The message may be on its way. Refunding would let it be sent again for
    // free, and retrying would bill the tenant twice.
    expect(outcome.reservedRial).toBeGreaterThan(0);
    expect(await balanceOf(alpha.businessId)).toBe(before - outcome.reservedRial);
  });
});
