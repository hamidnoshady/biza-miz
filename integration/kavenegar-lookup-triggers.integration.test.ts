/**
 * Issue #902 §5 acceptance — a business event becomes one approved message.
 *
 * `kavenegar-lookup-send.integration.test.ts` proves one send is honest (the
 * child's key, one charge, a full refund on a definitive refusal). This file
 * proves the step above it, in the issue's own terms:
 *
 *   1. Nothing sends until the business turns the event on: a trigger with no
 *      row is `trigger_disabled`, not a default.
 *   2. A message the event cannot fill is refused at configuration time and
 *      again at send time (`trigger_variable_unsupported`,
 *      `template_variables_undeclared`) — the mapping is what makes the text
 *      truthful, so it never guesses.
 *   3. One fact is one message: a replayed bump, and two bumps racing, produce
 *      exactly one provider call and one charge.
 *   4. A customer who said «پیامک نفرست» gets no SMS, and the refusal is
 *      recorded as `skipped/no_consent` rather than as a silent nothing.
 *   5. An empty wallet blocks the send *before* the provider is called.
 *
 * No network call is made: the §5d executor seam is injected and every reply is
 * a recorded fixture.
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
let triggers: typeof import("../src/lib/kavenegar/lookup-triggers");
let credentials: typeof import("../src/lib/kavenegar/credentials");
let rest: typeof import("../src/lib/kavenegar/rest");

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

async function lookupTemplate(
  businessId: string,
  input: { body?: string; variables?: string[]; state?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO kavenegar_lookup_templates
       (business_id, name, title, body, purpose, state, variables, provider_template_id,
        decided_at, archived_at)
     VALUES ($1, $2, 'آمادهٔ تحویل سفارش', $3, 'transactional', $4, $5, 9001, now(), NULL)
     RETURNING id`,
    [
      businessId,
      `bm${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      input.body ?? "%token عزیز، سفارش شما در %token2 آمادهٔ تحویل است.",
      input.state ?? "approved",
      input.variables ?? ["customer_name", "store_name"],
    ],
  );
  return rows[0]!.id;
}

async function locationFor(businessId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ مرکزی') RETURNING id`,
    [businessId],
  );
  return rows[0]!.id;
}

async function customerFor(
  businessId: string,
  input: { name?: string; phone?: string; consent?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles, phone, phone_kind, sms_consent)
     VALUES ($1, $2, 'customer', ARRAY['customer']::text[], $3, 'mobile', $4)
     RETURNING id`,
    [businessId, input.name ?? "سارا", input.phone ?? "09121234567", input.consent ?? true],
  );
  return rows[0]!.id;
}

async function orderFor(locationId: string, customerId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, customer_id)
     VALUES ($1, (SELECT coalesce(max(order_number), 0) + 1 FROM orders WHERE location_id = $1), 'dine_in', 'open', $2)
     RETURNING id`,
    [locationId, customerId],
  );
  return rows[0]!.id;
}

/** A recorded reply from the provider's documentation. */
function ok(cost = "150") {
  return { messageId: "1234567", costRial: Number(cost), status: 5 };
}

function executor() {
  const calls: { apiKey: string; template: string; receptor: string; tokens: string[] }[] = [];
  const execute: import("../src/lib/kavenegar/rest").LookupSendExecutor = async (request) => {
    calls.push({
      apiKey: request.apiKey,
      template: request.template,
      receptor: request.receptor,
      tokens: request.tokens,
    });
    return ok();
  };
  return { calls, execute };
}

async function balanceOf(businessId: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
       FROM wallet_ledger WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]?.balance ?? 0);
}

async function sendLog(businessId: string) {
  const { rows } = await db.query<{
    trigger_key: string;
    event_key: string;
    status: string;
    code: string | null;
    charged_rial: string;
    provider_message_id: string | null;
  }>(
    `SELECT trigger_key, event_key, status, code, charged_rial, provider_message_id
       FROM kavenegar_lookup_trigger_sends WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_kavenegar_triggers_${randomUUID().replaceAll("-", "")}`;

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
  triggers = await import("../src/lib/kavenegar/lookup-triggers");
  credentials = await import("../src/lib/kavenegar/credentials");
  rest = await import("../src/lib/kavenegar/rest");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // A real base rate, so the money assertions are about money and not zero.
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
  await db.query("DELETE FROM kavenegar_lookup_trigger_sends");
  await db.query("DELETE FROM kavenegar_lookup_triggers");
  await db.query("DELETE FROM kavenegar_lookup_templates");
  await db.query("DELETE FROM kavenegar_business_accounts");
  await db.query("DELETE FROM wallet_ledger");
  await db.query("DELETE FROM business_wallets");
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  await fundWallet(alpha.businessId, 500_000);
  await activateChild(alpha.businessId);
});

describe("configuring an automation", () => {
  it("refuses a message the provider has not approved", async () => {
    const templateId = await lookupTemplate(alpha.businessId, { state: "submitted" });
    await expect(
      triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId }),
    ).rejects.toThrow(/template_not_approved/);
  });

  it("refuses a message with no declared mapping", async () => {
    const templateId = await lookupTemplate(alpha.businessId, { variables: [] });
    await expect(
      triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId }),
    ).rejects.toThrow(/template_variables_undeclared/);
  });

  it("refuses a message that wants a fact an order-ready event does not have", async () => {
    // `amount` belongs to a payment, not to a ready ticket. Accepting the pair
    // would put a blank — or worse, a stale value — in the customer's sentence.
    const templateId = await lookupTemplate(alpha.businessId, { variables: ["customer_name", "amount"] });
    await expect(
      triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId }),
    ).rejects.toThrow(/trigger_variable_unsupported/);
  });

  it("refuses a trigger that is not in the vocabulary, including the login code", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await expect(
      triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "login_code", templateId }),
    ).rejects.toThrow(/invalid_trigger/);
  });

  it("saves the business's own choice and reports it back in first-party words", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });

    const settings = await triggers.listTriggerSettings(alpha.businessId);
    expect(settings.map((setting) => setting.trigger)).toEqual(["order_ready", "payment_received"]);
    const ready = settings.find((setting) => setting.trigger === "order_ready")!;
    expect(ready.enabled).toBe(true);
    expect(ready.templateId).toBe(templateId);
    expect(ready.templateTitle).toBe("آمادهٔ تحویل سفارش");
    expect(ready.problem).toBeNull();

    // The second trigger was never configured, so it is off — not defaulted on.
    const payment = settings.find((setting) => setting.trigger === "payment_received")!;
    expect(payment.enabled).toBe(false);
    expect(payment.templateId).toBeNull();
  });

  it("shows the exact message the event would send, and what it has sent so far", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });

    const before = (await triggers.listTriggerSettings(alpha.businessId)).find(
      (setting) => setting.trigger === "order_ready",
    )!;
    // §9 item 0: a preview rendered by the dispatcher's own renderer, with the
    // sample facts — no %token left, and nothing a tenant could mistake for a
    // real customer's message.
    expect(before.preview).toBeTruthy();
    expect(before.preview).not.toMatch(/%token/);
    expect(before.preview).toContain("سارا محمدی");
    // Nothing has happened yet, and the screen says so rather than showing a
    // silent zero.
    expect(before.delivery).toMatchObject({ sent: 0, skipped: 0, lastCode: null });

    // One sent, one refused for consent: two different facts, counted apart.
    await db.query(
      `INSERT INTO kavenegar_lookup_trigger_sends
         (business_id, trigger_key, event_key, status, code, charged_rial)
       VALUES ($1, 'order_ready', 'order:1', 'sent', NULL, 2400),
              ($1, 'order_ready', 'order:2', 'skipped', 'no_consent', 0),
              ($1, 'payment_received', 'payment:1', 'unknown', 'unknown_outcome', 0)`,
      [alpha.businessId],
    );

    const after = await triggers.listTriggerSettings(alpha.businessId);
    const ready = after.find((setting) => setting.trigger === "order_ready")!;
    expect(ready.delivery).toMatchObject({ sent: 1, skipped: 1, blocked: 0, failed: 0 });
    expect(ready.delivery.lastCode).toBe("no_consent");
    expect(ready.delivery.lastAttemptAt).not.toBeNull();

    const payment = after.find((setting) => setting.trigger === "payment_received")!;
    expect(payment.delivery).toMatchObject({ sent: 0, skipped: 0, unknown: 1 });

    // Another business sees none of it.
    const beta = await seedBusiness("Beta");
    const theirs = await triggers.listTriggerSettings(beta.businessId);
    expect(theirs.every((setting) => setting.delivery.sent === 0)).toBe(true);
  });
});

describe("dispatching one event", () => {
  it("sends nothing when the business never turned the trigger on", async () => {
    const { calls, execute } = executor();
    const outcome = await triggers.dispatchLookupTrigger({
      businessId: alpha.businessId,
      trigger: "order_ready",
      eventKey: "order:00000000-0000-4000-8000-000000000009",
      receptor: "09121234567",
      facts: { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "9" },
      execute,
    });
    expect(outcome).toEqual({ status: "blocked", code: "trigger_disabled" });
    expect(calls).toHaveLength(0);
    const log = await sendLog(alpha.businessId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "blocked", code: "trigger_disabled" });
  });

  it("sends once on the child's key and charges retail exactly once", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    const before = await balanceOf(alpha.businessId);
    const { calls, execute } = executor();

    const outcome = await triggers.dispatchLookupTrigger({
      businessId: alpha.businessId,
      trigger: "order_ready",
      eventKey: "order:00000000-0000-4000-8000-000000000010",
      receptor: "09121234567",
      facts: { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "10" },
      execute,
    });

    expect(outcome.status).toBe("sent");
    expect(calls).toHaveLength(1);
    // The business's own account pays for the message (§5), never the master's.
    expect(calls[0]!.apiKey).toBe(CHILD_KEY);
    expect(calls[0]!.tokens).toEqual(["سارا", "کافهٔ نمونه"]);
    expect(await balanceOf(alpha.businessId)).toBeLessThan(before);

    const log = await sendLog(alpha.businessId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "sent", provider_message_id: "1234567" });
    expect(Number(log[0]!.charged_rial)).toBe(before - (await balanceOf(alpha.businessId)));
  });

  it("treats a replayed bump as the same fact, not a second message", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    const { calls, execute } = executor();
    const input = {
      businessId: alpha.businessId,
      trigger: "order_ready" as const,
      eventKey: "order:00000000-0000-4000-8000-000000000011",
      receptor: "09121234567",
      facts: { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "11" },
      execute,
    };

    expect((await triggers.dispatchLookupTrigger(input)).status).toBe("sent");
    expect(await triggers.dispatchLookupTrigger(input)).toEqual({ status: "duplicate" });
    expect(calls).toHaveLength(1);
    expect(await sendLog(alpha.businessId)).toHaveLength(1);
  });

  it("sends once when two kitchen terminals bump the last two lines at the same time", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    const { calls, execute } = executor();
    const input = {
      businessId: alpha.businessId,
      trigger: "order_ready" as const,
      eventKey: "order:00000000-0000-4000-8000-000000000012",
      receptor: "09121234567",
      facts: { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "12" },
      execute,
    };

    // The claim row is the lock: the loser of the race never reaches the
    // provider and never reserves credit.
    const results = await Promise.all([
      triggers.dispatchLookupTrigger(input),
      triggers.dispatchLookupTrigger(input),
    ]);
    expect(results.filter((result) => result.status === "sent")).toHaveLength(1);
    expect(results.filter((result) => result.status === "duplicate")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("refuses to charge when the wallet is empty, before the provider is called", async () => {
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    await db.query("DELETE FROM wallet_ledger");
    await db.query("DELETE FROM business_wallets");
    const { calls, execute } = executor();

    const outcome = await triggers.dispatchLookupTrigger({
      businessId: alpha.businessId,
      trigger: "order_ready",
      eventKey: "order:00000000-0000-4000-8000-000000000013",
      receptor: "09121234567",
      facts: { customerName: "سارا", storeName: "کافهٔ نمونه", orderNumber: "13" },
      execute,
    });
    expect(outcome).toEqual({ status: "blocked", code: "insufficient_credit" });
    expect(calls).toHaveLength(0);
  });
});

describe("notifyOrderReady — the real event, from the order itself", () => {
  async function arrange(order: { consent?: boolean; phone?: string | null; customer?: boolean }) {
    const locationId = await locationFor(alpha.businessId);
    const customerId = order.customer === false ? null : await customerFor(alpha.businessId, {
      consent: order.consent ?? true,
      ...(order.phone === null ? { phone: "" } : order.phone ? { phone: order.phone } : {}),
    });
    const orderId = await orderFor(locationId, customerId);
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    return { locationId, customerId, orderId };
  }

  it("reads the order, the customer and the store, and sends the approved message", async () => {
    const { locationId, orderId } = await arrange({});
    const { calls, execute } = executor();

    const outcome = await triggers.notifyOrderReady({
      businessId: alpha.businessId,
      locationId,
      orderId,
      execute,
    });

    expect(outcome.status).toBe("sent");
    expect(calls).toHaveLength(1);
    // The store's name comes from the business that owns the location, and the
    // customer's name from the party record — not from the event payload.
    expect(calls[0]!.tokens).toEqual(["سارا", "Alpha"]);
    expect(calls[0]!.receptor).toBe("09121234567");
  });

  it("honours a customer's «پیامک نفرست» even for a transactional message", async () => {
    const { locationId, orderId } = await arrange({ consent: false });
    const { calls, execute } = executor();

    const outcome = await triggers.notifyOrderReady({
      businessId: alpha.businessId,
      locationId,
      orderId,
      execute,
    });

    expect(outcome).toEqual({ status: "skipped", code: "no_consent" });
    expect(calls).toHaveLength(0);
    const log = await sendLog(alpha.businessId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "skipped", code: "no_consent" });
  });

  it("skips an order with no customer at all, without inventing a recipient", async () => {
    const { locationId, orderId } = await arrange({ customer: false });
    const { calls, execute } = executor();
    expect(await triggers.notifyOrderReady({ businessId: alpha.businessId, locationId, orderId, execute })).toEqual({
      status: "skipped",
      code: "no_customer",
    });
    expect(calls).toHaveLength(0);
  });

  it("skips a customer with no usable mobile, and says which fact was missing", async () => {
    const locationId = await locationFor(alpha.businessId);
    const customerId = await customerFor(alpha.businessId, { phone: "02112345678" });
    const orderId = await orderFor(locationId, customerId);
    const templateId = await lookupTemplate(alpha.businessId);
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "order_ready", templateId });
    const { calls, execute } = executor();

    expect(await triggers.notifyOrderReady({ businessId: alpha.businessId, locationId, orderId, execute })).toEqual({
      status: "skipped",
      code: "missing_phone",
    });
    expect(calls).toHaveLength(0);
  });

  it("sends the receipt for a recorded payment, with the amount in Persian digits", async () => {
    const locationId = await locationFor(alpha.businessId);
    const customerId = await customerFor(alpha.businessId, { name: "سارا" });
    const orderId = await orderFor(locationId, customerId);
    const templateId = await lookupTemplate(alpha.businessId, {
      body: "پرداخت %token ریالی شما در %token2 ثبت شد.",
      variables: ["amount", "store_name"],
    });
    await triggers.saveTriggerSetting({ businessId: alpha.businessId, trigger: "payment_received", templateId });
    const { calls, execute } = executor();

    const outcome = await triggers.notifyPaymentReceived({
      businessId: alpha.businessId,
      locationId,
      orderId,
      amountRial: 250_000,
      execute,
    });

    expect(outcome.status).toBe("sent");
    // The renderer groups and localises; the caller passes an integer.
    expect(calls[0]!.tokens).toEqual(["۲۵۰٬۰۰۰", "Alpha"]);
    const log = await sendLog(alpha.businessId);
    expect(log[0]).toMatchObject({ trigger_key: "payment_received", event_key: `payment:${orderId}`, status: "sent" });
  });

  it("sends one receipt when the same settlement is replayed", async () => {
    const locationId = await locationFor(alpha.businessId);
    const customerId = await customerFor(alpha.businessId);
    const orderId = await orderFor(locationId, customerId);
    await triggers.saveTriggerSetting({
      businessId: alpha.businessId,
      trigger: "payment_received",
      templateId: await lookupTemplate(alpha.businessId, {
        body: "پرداخت %token ریالی شما در %token2 ثبت شد.",
        variables: ["amount", "store_name"],
      }),
    });
    const { calls, execute } = executor();
    const input = { businessId: alpha.businessId, locationId, orderId, amountRial: 90_000, execute };

    expect((await triggers.notifyPaymentReceived(input)).status).toBe("sent");
    expect(await triggers.notifyPaymentReceived(input)).toEqual({ status: "duplicate" });
    expect(calls).toHaveLength(1);
  });

  it("never throws, even when the send path is broken", async () => {
    const { locationId, orderId } = await arrange({});
    const failing: import("../src/lib/kavenegar/rest").LookupSendExecutor = async () => {
      const { classifyKavenegarStatus } = await import("../src/lib/kavenegar/client");
      throw new rest.KavenegarManagementError({
        // 424 is the provider's "this template is not approved" — a definitive
        // refusal, so §5d refunds in full and reports a provider-neutral code.
        classification: classifyKavenegarStatus(424),
        operatorUrl: "https://api.kavenegar.com/v1/***/verify/lookup.json",
        providerMessage: "template not approved",
        providerStatus: 424,
      });
    };
    // A definitive refusal is `failed` with a refund, never an exception in the
    // middle of a kitchen bump.
    const outcome = await triggers.notifyOrderReady({
      businessId: alpha.businessId,
      locationId,
      orderId,
      execute: failing,
    });
    expect(outcome.status).toBe("failed");
  });
});
