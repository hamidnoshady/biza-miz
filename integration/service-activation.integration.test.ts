/**
 * Service activation, setup & hourly wallet billing + retention (issue #1041).
 *
 * End-to-end against a real Postgres, covering the acceptance list:
 *
 *   1. fail closed — an unpriced service cannot activate and moves no money;
 *   2. the first setup debit happens exactly ONCE (duplicate activation, the
 *      hourly clock starts, the setup evidence exists);
 *   3. enabled time settles at the interval's price version, prorated by the
 *      second (1h20m = 4800s), and a repeated worker pass never double-charges;
 *   4. a customer disable closes the interval, starts the retention countdown
 *      and charges nothing after the disable instant;
 *   5. re-enable before the deadline cancels the purge and charges NO second
 *      setup fee;
 *   6. a purge deletes only service-owned data, journals the blocked scope as
 *      "partial" and leaves the wallet/ledger/setup evidence intact;
 *   7. legal hold blocks, and an outage/credit suspension never starts a
 *      retention countdown (only a customer disable does);
 *   8. an unaffordable segment suspends the service instead of creating debt.
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
let wallet: typeof import("../src/lib/wallet-service");
let activation: typeof import("../src/lib/service-activation/activation-service");
let pricing: typeof import("../src/lib/service-activation/pricing-service");
let retention: typeof import("../src/lib/service-activation/retention-service");
let gate: typeof import("../src/lib/service-activation/app-gate-service");

const BUSINESS_A = "55555555-5555-4555-8555-555555555555";
const BUSINESS_B = "66666666-6666-4666-8666-666666666666";

const T0 = new Date("2026-10-01T08:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_service_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  wallet = await import("../src/lib/wallet-service");
  activation = await import("../src/lib/service-activation/activation-service");
  pricing = await import("../src/lib/service-activation/pricing-service");
  retention = await import("../src/lib/service-activation/retention-service");
  gate = await import("../src/lib/service-activation/app-gate-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES
       ($1, 'کسب‌وکار الف', 'service-alpha', 'pro'),
       ($2, 'کسب‌وکار ب', 'service-beta', 'pro')`,
    [BUSINESS_A, BUSINESS_B],
  );
}, 180_000);

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

beforeEach(async () => {
  await db.query(`DELETE FROM service_activation_events`);
  await db.query(`DELETE FROM service_purge_journal`);
  await db.query(`DELETE FROM service_purge_queue`);
  await db.query(`DELETE FROM service_runtime_charges`);
  await db.query(`DELETE FROM service_setup_charges`);
  await db.query(`DELETE FROM service_activation_intervals`);
  await db.query(`DELETE FROM business_service_activations`);
  await db.query(`DELETE FROM business_service_wizard_state`);
  await db.query(`DELETE FROM business_service_retention_overrides`);
  await db.query(`DELETE FROM service_retention_policies`);
  await db.query(`DELETE FROM service_price_schedules`);
  await db.query(`DELETE FROM notification_events`);
  await db.query(`DELETE FROM wallet_ledger`);
  await db.query(`DELETE FROM billing_usage_events`);
  await db.query(`DELETE FROM business_wallets`);

  await wallet.grantCredits({ businessId: BUSINESS_A, amountRial: 5_000_000 });
});

async function balance(businessId = BUSINESS_A): Promise<number> {
  const { rows } = await db.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]?.balance_rial ?? 0);
}

async function ledgerRows(kind: string, businessId = BUSINESS_A) {
  const { rows } = await db.query<{ amount_rial: string; direction: string }>(
    `SELECT amount_rial, direction FROM wallet_ledger
      WHERE business_id = $1 AND kind = $2 ORDER BY created_at`,
    [businessId, kind],
  );
  return rows;
}

async function publishCrmTariff(options: {
  setupHours?: number;
  hourlyRateRial?: number;
  published?: boolean;
} = {}) {
  return pricing.publishServicePrice({
    kind: "app",
    key: "crm",
    setupMode: "hour_equivalent",
    setupEquivalentHours: options.setupHours ?? 24,
    hourlyRateRial: options.hourlyRateRial ?? 100_000,
    published: options.published ?? true,
    effectiveFrom: at(-60).toISOString(),
  });
}

async function activateCrm(now = T0) {
  return activation.activateService({
    businessId: BUSINESS_A,
    identity: { kind: "app", key: "crm" },
    requestId: "req-1",
    now,
  });
}

async function seedCrmPurgeData() {
  const { rows: pipelineRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_pipelines (business_id, name, is_default)
     VALUES ($1, 'Purge test pipeline', false) RETURNING id`,
    [BUSINESS_A],
  );
  const pipelineId = pipelineRows[0].id;
  const { rows: stageRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_pipeline_stages (business_id, pipeline_id, name)
     VALUES ($1, $2, 'Purge test stage') RETURNING id`,
    [BUSINESS_A, pipelineId],
  );
  const { rows: leadRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_leads (business_id, name) VALUES ($1, 'Purge test lead') RETURNING id`,
    [BUSINESS_A],
  );
  const { rows: partyRows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles) VALUES ($1, 'Preserved converted party', ARRAY['customer']::text[]) RETURNING id`,
    [BUSINESS_A],
  );
  const { rows: convertedLeadRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_leads (business_id, name, converted_party_id, converted_at)
     VALUES ($1, 'Preserved converted lead', $2, now()) RETURNING id`,
    [BUSINESS_A, partyRows[0].id],
  );
  await db.query(
    `INSERT INTO platform_company_web_leads (business_id, site_key, idempotency_key, name, lead_id)
     VALUES ($1, 'purge-test-site', 'preserve-this-lead', 'Preserved web lead', $2)`,
    [BUSINESS_A, convertedLeadRows[0].id],
  );
  const { rows: dealRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_deals (business_id, title, pipeline_id, stage_id, lead_id)
     VALUES ($1, 'Purge test deal', $2, $3, $4) RETURNING id`,
    [BUSINESS_A, pipelineId, stageRows[0].id, leadRows[0].id],
  );
  const { rows: linkedDealRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_deals (business_id, title, pipeline_id, stage_id)
     VALUES ($1, 'Workspace-linked deal', $2, $3) RETURNING id`,
    [BUSINESS_A, pipelineId, stageRows[0].id],
  );
  await db.query(
    `INSERT INTO ai_projects (business_id, name, created_by, source_deal_id)
     VALUES ($1, 'Linked workspace project', 'test', $2)`,
    [BUSINESS_A, linkedDealRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_lead_vehicle_preferences (business_id, lead_id, make)
     VALUES ($1, $2, 'Purge test make')`,
    [BUSINESS_A, leadRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_deal_stage_history (business_id, deal_id, to_stage_id, to_stage_name) VALUES
       ($1, $2, $4, 'Purge test stage'),
       ($1, $3, $4, 'Purge test stage')`,
    [BUSINESS_A, dealRows[0].id, linkedDealRows[0].id, stageRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_activities (business_id, deal_id, kind, subject) VALUES
       ($1, $2, 'note', 'Purge test activity'),
       ($1, $3, 'note', 'Preserved linked-deal activity')`,
    [BUSINESS_A, dealRows[0].id, linkedDealRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_saved_views (business_id, entity, name)
     VALUES ($1, 'leads', 'Purge test view')`,
    [BUSINESS_A],
  );
  await db.query(`INSERT INTO crm_scoring_state (business_id) VALUES ($1)`, [BUSINESS_A]);
  const { rows: automationRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_automations (business_id, name, trigger_key, action_key)
     VALUES ($1, 'Purge test automation', 'lead.created', 'create_task') RETURNING id`,
    [BUSINESS_A],
  );
  await db.query(
    `INSERT INTO crm_automation_runs
       (business_id, automation_id, automation_name, trigger_key, entity_type, outcome)
     VALUES ($1, $2, 'Purge test automation', 'lead.created', 'lead', 'applied')`,
    [BUSINESS_A, automationRows[0].id],
  );
  const { rows: caseRows } = await db.query<{ id: string }>(
    `INSERT INTO crm_cases (business_id, subject) VALUES ($1, 'Preserved legal case') RETURNING id`,
    [BUSINESS_A],
  );
  await db.query(
    `INSERT INTO crm_case_events (business_id, case_id, kind, body)
     VALUES ($1, $2, 'created', 'Preserved case history')`,
    [BUSINESS_A, caseRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_activities (business_id, case_id, kind, subject)
     VALUES ($1, $2, 'note', 'Preserved case activity')`,
    [BUSINESS_A, caseRows[0].id],
  );
  const { rows: fields } = await db.query<{ id: string; target: string }>(
    `INSERT INTO crm_custom_fields (business_id, target, key, label, field_type) VALUES
       ($1, 'lead', 'purge_lead', 'Purge lead field', 'text'),
       ($1, 'deal', 'purge_deal', 'Purge deal field', 'text'),
       ($1, 'case', 'purge_case', 'Purge case field', 'text')
     RETURNING id, target`,
    [BUSINESS_A],
  );
  const fieldByTarget = new Map(fields.map((field) => [field.target, field.id]));
  await db.query(
    `INSERT INTO crm_custom_field_values (business_id, field_id, lead_id, value_text)
     VALUES ($1, $2, $3, 'delete lead value')`,
    [BUSINESS_A, fieldByTarget.get('lead'), leadRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_custom_field_values (business_id, field_id, deal_id, value_text)
     VALUES ($1, $2, $3, 'delete deal value'),
            ($1, $2, $4, 'preserve linked deal value')`,
    [BUSINESS_A, fieldByTarget.get('deal'), dealRows[0].id, linkedDealRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_custom_field_values (business_id, field_id, case_id, value_text)
     VALUES ($1, $2, $3, 'preserve case value')`,
    [BUSINESS_A, fieldByTarget.get('case'), caseRows[0].id],
  );
  await db.query(
    `INSERT INTO crm_audit_events (business_id, kind, entity_type, summary)
     VALUES ($1, 'created', 'lead', 'Preserved audit event')`,
    [BUSINESS_A],
  );
}

async function setRetention(days: number | null, enabled = true) {
  return retention.saveRetentionPolicy({
    kind: "app",
    key: "crm",
    autoPurgeEnabled: enabled,
    retentionDays: days,
  });
}

describe("pricing eligibility", () => {
  it("fails closed for an unpriced service and moves no money", async () => {
    const before = await balance();
    const result = await activateCrm();
    expect(result.status).toBe("not_configured");
    expect(await balance()).toBe(before);
    expect(await ledgerRows("service_setup")).toHaveLength(0);
    expect(await activation.getServiceActivation(BUSINESS_A, { kind: "app", key: "crm" })).toBeNull();
  });

  it("treats an unpublished tariff as ineligible even when it has figures", async () => {
    await publishCrmTariff({ published: false });
    const quote = await pricing.quoteService(BUSINESS_A, { kind: "app", key: "crm" });
    expect(quote.eligible).toBe(false);
    expect(quote.reason).toBe("not_configured");
    expect((await activateCrm()).status).toBe("not_configured");
  });

  it("quotes the setup debit, reserve and 24h/30d estimates before consent", async () => {
    await publishCrmTariff();
    const quote = await pricing.quoteService(BUSINESS_A, { kind: "app", key: "crm" });
    expect(quote.eligible).toBe(true);
    expect(quote.setupRial).toBe(2_400_000);
    expect(quote.hourlyRial).toBe(100_000);
    expect(quote.reserveRial).toBe(2_500_000);
    expect(quote.estimated24hRial).toBe(2_400_000);
    expect(quote.estimated30dRial).toBe(72_000_000);
    expect(quote.additionalCharges.length).toBeGreaterThan(0);
  });

  it("refuses the first activation when the wallet cannot cover setup + one hour", async () => {
    await publishCrmTariff();
    await db.query(`UPDATE business_wallets SET balance_rial = 2_499_999 WHERE business_id = $1`, [
      BUSINESS_A,
    ]);
    const result = await activateCrm();
    expect(result.status).toBe("insufficient_credit");
    if (result.status === "insufficient_credit") {
      expect(result.requiredRial).toBe(2_500_000);
    }
    expect(await ledgerRows("service_setup")).toHaveLength(0);
  });
});

describe("first activation", () => {
  it("debits the setup fee exactly once and starts the hourly clock", async () => {
    await publishCrmTariff();
    const result = await activateCrm();
    expect(result.status).toBe("activated");
    if (result.status !== "activated") return;

    expect(result.chargedSetupRial).toBe(2_400_000);
    expect(result.activation.state).toBe("active");
    expect(result.activation.setupPaid).toBe(true);
    expect(await balance()).toBe(2_600_000);

    const debits = await ledgerRows("service_setup");
    expect(debits).toHaveLength(1);
    expect(Number(debits[0].amount_rial)).toBe(2_400_000);
    expect(debits[0].direction).toBe("debit");

    const { rows: setupRows } = await db.query(
      `SELECT amount_rial, price_version FROM service_setup_charges WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(setupRows).toHaveLength(1);
    expect(Number(setupRows[0].amount_rial)).toBe(2_400_000);

    const { rows: intervals } = await db.query(
      `SELECT started_at, ended_at FROM service_activation_intervals WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ended_at).toBeNull();

    const { rows: usage } = await db.query(
      `SELECT quantity, meter_key FROM billing_usage_events WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].meter_key).toBe("service.setup");
    expect(Number(usage[0].quantity)).toBe(1);
  });

  it("never charges setup twice for a duplicate or parallel activation request", async () => {
    await publishCrmTariff();
    const first = await activateCrm();
    expect(first.status).toBe("activated");

    // Sequential duplicate, and two more fired at once — all must be no-ops.
    const duplicate = await activateCrm();
    expect(["already_active", "reenabled"]).toContain(duplicate.status);
    const parallel = await Promise.all([
      activateCrm(at(1)),
      activateCrm(at(1)),
      activateCrm(at(1)),
    ]);
    for (const result of parallel) {
      expect(["already_active", "reenabled"]).toContain(result.status);
    }

    expect(await ledgerRows("service_setup")).toHaveLength(1);
    expect(await balance()).toBe(2_600_000);
  });

  it("keeps a second business's activation and pricing independent", async () => {
    await publishCrmTariff();
    await wallet.grantCredits({ businessId: BUSINESS_B, amountRial: 5_000_000 });
    const result = await activation.activateService({
      businessId: BUSINESS_B,
      identity: { kind: "app", key: "crm" },
      now: T0,
    });
    expect(result.status).toBe("activated");
    expect(await balance(BUSINESS_A)).toBe(5_000_000);
    expect(await balance(BUSINESS_B)).toBe(2_600_000);
  });
});

describe("enabled-time settlement", () => {
  it("bills 1h20m as exactly 80 minutes, once", async () => {
    await publishCrmTariff();
    await activateCrm();

    const first = await activation.settleDueServiceRuntime({ now: at(80) });
    expect(first.settled).toBe(1);
    expect(first.billedSeconds).toBe(4800);
    // 4800s × 100,000 Rial/hour = 133,333.33… → rounded up once to 133,334.
    expect(first.billedRial).toBe(133_334);
    expect(await balance()).toBe(2_466_666);
    expect(await ledgerRows("service_runtime")).toHaveLength(1);

    const again = await activation.settleDueServiceRuntime({ now: at(80) });
    expect(again.billedRial).toBe(0);
    expect(await balance()).toBe(2_466_666);
    expect(await ledgerRows("service_runtime")).toHaveLength(1);

    const { rows } = await db.query<{ billed_seconds: string; amount_rial: string }>(
      `SELECT billed_seconds, amount_rial FROM service_runtime_charges WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].billed_seconds)).toBe(4800);
    expect(Number(rows[0].amount_rial)).toBe(133_334);
  });

  it("settles only the not-yet-settled segments across restarts", async () => {
    await publishCrmTariff();
    await activateCrm();

    await activation.settleDueServiceRuntime({ now: at(60) });
    await activation.settleDueServiceRuntime({ now: at(120) });

    const { rows } = await db.query<{ billed_seconds: string }>(
      `SELECT billed_seconds FROM service_runtime_charges
        WHERE business_id = $1 ORDER BY period_start`,
      [BUSINESS_A],
    );
    expect(rows.map((row) => Number(row.billed_seconds))).toEqual([3600, 3600]);
    expect(await ledgerRows("service_runtime")).toHaveLength(2);
    expect(await balance()).toBe(5_000_000 - 2_400_000 - 200_000);
  });

  it("keeps the price version each interval was opened at when the tariff changes", async () => {
    await publishCrmTariff();
    await activateCrm();
    await activation.settleDueServiceRuntime({ now: at(60) });

    // A new published price must not touch already-open intervals.
    await pricing.publishServicePrice({
      kind: "app",
      key: "crm",
      setupMode: "hour_equivalent",
      setupEquivalentHours: 24,
      hourlyRateRial: 1_000_000,
    });
    await activation.settleDueServiceRuntime({ now: at(120) });

    const { rows } = await db.query<{ hourly_rate_rial: string; amount_rial: string }>(
      `SELECT hourly_rate_rial, amount_rial FROM service_runtime_charges
        WHERE business_id = $1 ORDER BY period_start`,
      [BUSINESS_A],
    );
    expect(rows.map((row) => Number(row.hourly_rate_rial))).toEqual([100_000, 100_000]);
    expect(rows.map((row) => Number(row.amount_rial))).toEqual([100_000, 100_000]);
  });
});

describe("disable, retention and re-enable", () => {
  it("closes billing at the disable instant and starts the retention countdown", async () => {
    await publishCrmTariff();
    await setRetention(30);
    await activateCrm();
    await activation.settleServiceRuntime({ businessId: BUSINESS_A, identity: { kind: "app", key: "crm" }, now: at(80) });
    const afterFirstSettle = await balance();

    const disabled = await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(90),
    });
    expect(disabled.status).toBe("disabled");
    if (disabled.status !== "disabled") return;

    // The final 10 minutes are settled on the close.
    expect(disabled.settlement.billedSeconds).toBe(600);
    // 600s × 100,000/h = 16,666.67 → 16,667, settled on the close.
    expect(await balance()).toBe(afterFirstSettle - 16_667);
    expect(disabled.activation.state).toBe("disabled_retained");
    expect(disabled.activation.disabledReason).toBe("customer");
    expect(disabled.retentionDeadline).toBe(at(90 + 30 * 24 * 60).toISOString());
    expect(disabled.activation.purgeState).toBe("scheduled");

    const { rows: queue } = await db.query(
      `SELECT state, scheduled_at FROM service_purge_queue WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].state).toBe("scheduled");

    // Nothing is charged after the disable, however far the clock moves.
    const later = await activation.settleDueServiceRuntime({ now: at(90 + 10 * 24 * 60) });
    expect(later.billedRial).toBe(0);
    expect(await ledgerRows("service_runtime")).toHaveLength(2);
  });

  it("re-enables before the deadline with no second setup fee and cancels the purge", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });
    const afterDisable = await balance();

    const reenabled = await activation.reenableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60 + 24 * 60),
    });
    expect(reenabled.status).toBe("reenabled");
    if (reenabled.status !== "reenabled") return;
    expect(reenabled.chargedSetupRial).toBe(0);
    expect(reenabled.activation.state).toBe("active");
    expect(reenabled.activation.retentionDeadline).toBeNull();
    expect(await balance()).toBe(afterDisable);
    expect(await ledgerRows("service_setup")).toHaveLength(1);

    const { rows: queue } = await db.query(
      `SELECT state FROM service_purge_queue WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(queue[0].state).toBe("cancelled");

    const { rows: intervals } = await db.query<{ trigger: string; ended_at: Date | null }>(
      `SELECT trigger, ended_at FROM service_activation_intervals
        WHERE business_id = $1 ORDER BY started_at`,
      [BUSINESS_A],
    );
    expect(intervals.map((row) => row.trigger)).toEqual(["activation", "reenable"]);
    expect(intervals[0].ended_at).not.toBeNull();
    expect(intervals[1].ended_at).toBeNull();
  });

  it("cancels a queued purge when the customer re-enables past the deadline", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });

    // The worker sees the deadline has passed, but the customer came back
    // first: the purge is cancelled, nothing is deleted.
    await activation.reenableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60 + 8 * 24 * 60),
    });
    const purge = await retention.runDueServicePurges({ now: at(60 + 9 * 24 * 60) });
    expect(purge.completed).toBe(0);
    expect(purge.partial).toBe(0);
    expect(
      await activation.getServiceActivation(BUSINESS_A, { kind: "app", key: "crm" }),
    ).toMatchObject({ state: "active" });
  });
});

describe("automatic destruction", () => {
  it("drys-run without touching data and journals the full plan", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await activation.saveServiceWizardState({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      step: "contacts",
      progress: { imported: 12 },
    });
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });

    const dry = await retention.runDueServicePurges({ now: at(60 + 8 * 24 * 60), dryRun: true });
    expect(dry.planned).toBe(1);
    expect(dry.completed).toBe(0);

    const { rows: wizard } = await db.query(
      `SELECT step FROM business_service_wizard_state WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(wizard).toHaveLength(1);

    const { rows: journal } = await db.query<{ status: string; scope: unknown }>(
      `SELECT status, scope FROM service_purge_journal WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(journal).toHaveLength(1);
    expect(journal[0].status).toBe("planned");
    expect((journal[0].scope as { dataset: string }[]).map((entry) => entry.dataset)).toContain(
      "wallet.ledger",
    );
  });

  it("deletes reviewed CRM-owned data, verifies it, and preserves shared/legal history", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await seedCrmPurgeData();
    await activation.saveServiceWizardState({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      step: "contacts",
      progress: { imported: 12 },
    });
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });
    const walletAfterDisable = await balance();

    const purge = await retention.runDueServicePurges({ now: at(60 + 8 * 24 * 60) });
    expect(purge.partial).toBe(1);
    expect(purge.completed).toBe(0);

    const { rows: wizard } = await db.query(
      `SELECT count(*)::text AS count FROM business_service_wizard_state WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(Number(wizard[0].count)).toBe(0);

    const expectedRemaining = {
      crm_activities: 2,
      crm_deal_stage_history: 1,
      crm_custom_field_values: 2,
      crm_lead_vehicle_preferences: 0,
      crm_lead_vehicle_links: 0,
      crm_deals: 1,
      crm_leads: 1,
      crm_pipeline_stages: 1,
      crm_pipelines: 1,
      crm_saved_views: 0,
      crm_scoring_state: 0,
      crm_automations: 0,
    } as const;
    for (const [table, expected] of Object.entries(expectedRemaining)) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE business_id = $1`,
        [BUSINESS_A],
      );
      expect(Number(rows[0].count), `${table} remaining rows`).toBe(expected);
    }
    const { rows: protectedCounts } = await db.query<{ cases: string; case_events: string; audit_events: string; automation_runs: string; detached_runs: string; protected_field_values: string; field_definitions: string; converted_leads: string; web_lead_links: string }>(
      `SELECT
         (SELECT count(*)::text FROM crm_cases WHERE business_id = $1) AS cases,
         (SELECT count(*)::text FROM crm_case_events WHERE business_id = $1) AS case_events,
         (SELECT count(*)::text FROM crm_audit_events WHERE business_id = $1) AS audit_events,
         (SELECT count(*)::text FROM crm_automation_runs WHERE business_id = $1) AS automation_runs,
         (SELECT count(*)::text FROM crm_automation_runs WHERE business_id = $1 AND automation_id IS NULL) AS detached_runs,
         (SELECT count(*)::text FROM crm_custom_field_values WHERE business_id = $1) AS protected_field_values,
         (SELECT count(*)::text FROM crm_custom_fields WHERE business_id = $1) AS field_definitions,
         (SELECT count(*)::text FROM crm_leads WHERE business_id = $1 AND converted_party_id IS NOT NULL) AS converted_leads,
         (SELECT count(*)::text FROM platform_company_web_leads WHERE business_id = $1 AND lead_id IS NOT NULL) AS web_lead_links`,
      [BUSINESS_A],
    );
    expect(protectedCounts[0]).toEqual({
      cases: "1",
      case_events: "1",
      audit_events: "1",
      automation_runs: "1",
      detached_runs: "1",
      protected_field_values: "2",
      field_definitions: "3",
      converted_leads: "1",
      web_lead_links: "1",
    });

    // Financial and commercial evidence survives.
    expect(await balance()).toBe(walletAfterDisable);
    expect(await ledgerRows("service_setup")).toHaveLength(1);
    const { rows: setups } = await db.query(
      `SELECT count(*)::text AS count FROM service_setup_charges WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(Number(setups[0].count)).toBe(1);

    const record = await activation.getServiceActivation(BUSINESS_A, {
      kind: "app",
      key: "crm",
    });
    expect(record?.purgeState).toBe("partial");
    expect(record?.state).toBe("eligible_for_purge");
    expect(record?.setupPaid).toBe(true);

    const { rows: journal } = await db.query<{ status: string; reclaimed: unknown }>(
      `SELECT status, reclaimed FROM service_purge_journal
        WHERE business_id = $1 AND dry_run = false`,
      [BUSINESS_A],
    );
    expect(journal[0].status).toBe("partial");
    expect(journal[0].reclaimed).toMatchObject({
      "service.wizard_state": 1,
      "crm.activities": 1,
      "crm.deal_stage_history": 1,
      "crm.custom_field_values_for_leads_and_deals": 2,
      "crm.automotive_lead_preferences": 1,
      "crm.automotive_lead_vehicle_links": 0,
      "crm.deals": 1,
      "crm.leads": 1,
      "crm.pipeline_stages": 0,
      "crm.pipelines": 0,
      "crm.saved_views": 1,
      "crm.scoring_state": 1,
      "crm.automations": 1,
    });
  });

  it("re-activates after a purge without charging a second setup fee", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });
    await retention.runDueServicePurges({ now: at(60 + 8 * 24 * 60) });
    const afterPurge = await balance();

    const again = await activation.activateService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60 + 9 * 24 * 60),
    });
    expect(again.status).toBe("reenabled");
    expect(await balance()).toBe(afterPurge);
    expect(await ledgerRows("service_setup")).toHaveLength(1);
  });

  it("does not purge before the deadline or while a legal hold is in force", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });

    const early = await retention.runDueServicePurges({ now: at(60 + 60) });
    expect(early.completed + early.partial + early.blocked).toBe(0);

    await activation.holdServiceActivation({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      note: "legal request",
    });
    // The hold moved the queued row to `blocked`, so the due sweep no longer
    // sees it at all — a held service is never even considered for deletion.
    const held = await retention.runDueServicePurges({ now: at(60 + 8 * 24 * 60) });
    expect(held.scanned).toBe(0);
    expect(held.completed + held.partial).toBe(0);
    expect(
      await activation.getServiceActivation(BUSINESS_A, { kind: "app", key: "crm" }),
    ).toMatchObject({ state: "legal_hold" });
    const { rows: queue } = await db.query<{ state: string }>(
      `SELECT state FROM service_purge_queue WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(queue[0].state).toBe("blocked");
  });
});

describe("suspension is not a customer disable", () => {
  it("stops billing and starts NO retention countdown on an outage", async () => {
    await publishCrmTariff();
    await setRetention(7);
    await activateCrm();

    const suspended = await activation.suspendService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      reason: "platform_unavailable",
      now: at(60),
    });
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") return;
    expect(suspended.activation.state).toBe("platform_unavailable");
    expect(suspended.activation.retentionDeadline).toBeNull();

    const { rows: queue } = await db.query(
      `SELECT count(*)::text AS count FROM service_purge_queue WHERE business_id = $1`,
      [BUSINESS_A],
    );
    expect(Number(queue[0].count)).toBe(0);

    const purge = await retention.runDueServicePurges({ now: at(60 + 365 * 24 * 60) });
    expect(purge.scanned).toBe(0);

    const walletAtSuspension = await balance();
    await activation.settleDueServiceRuntime({ now: at(60 + 48 * 60) });
    expect(await balance()).toBe(walletAtSuspension);
  });

  it("suspends an active service instead of charging uncovered time", async () => {
    await publishCrmTariff();
    await activateCrm();
    // Drain the wallet to less than one hour's charge.
    await db.query(`UPDATE business_wallets SET balance_rial = 1_000 WHERE business_id = $1`, [
      BUSINESS_A,
    ]);

    const tick = await activation.settleDueServiceRuntime({ now: at(120) });
    expect(tick.suspended).toBe(1);
    expect(await balance()).toBe(1_000);
    expect(await ledgerRows("service_runtime")).toHaveLength(0);

    const record = await activation.getServiceActivation(BUSINESS_A, {
      kind: "app",
      key: "crm",
    });
    expect(record?.state).toBe("suspended_insufficient_credit");
    expect(record?.suspensionReason).toBe("insufficient_credit");
    expect(record?.retentionDeadline).toBeNull();
  });
});

describe("the API gate reads the activation, not a guess", () => {
  it("answers null for a business that never activated the app", async () => {
    // "No row" is what keeps an existing customer working when this ships.
    expect(await gate.appServiceActivationState(BUSINESS_A, "accounting")).toBeNull();
    expect(await gate.isAppServiceOperational(BUSINESS_A, "accounting")).toBe(true);
  });

  it("reports the state a deliberate disable left behind", async () => {
    await publishCrmTariff();
    await activateCrm();
    const disabled = await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });
    expect(disabled.status).toBe("disabled");
    expect(await gate.appServiceActivationState(BUSINESS_A, "crm")).toBe("disabled_retained");
    expect(await gate.isAppServiceOperational(BUSINESS_A, "crm")).toBe(false);
    expect(await gate.appServiceActivationStates(BUSINESS_A)).toMatchObject({ crm: "disabled_retained" });
    // An app's own key is what the guard asks for; another app is untouched.
    expect(await gate.appServiceActivationState(BUSINESS_A, "accounting")).toBeNull();
  });

  it("reports a suspension as a suspension, never as a disable", async () => {
    await publishCrmTariff();
    await activateCrm();
    // The billing tick (not a single-service settle) is what suspends instead
    // of chasing uncovered credit.
    await db.query(`UPDATE business_wallets SET balance_rial = 1_000 WHERE business_id = $1`, [BUSINESS_A]);
    await activation.settleDueServiceRuntime({ now: at(120) });
    expect(await gate.appServiceActivationState(BUSINESS_A, "crm")).toBe(
      "suspended_insufficient_credit",
    );
    expect(await gate.isAppServiceOperational(BUSINESS_A, "crm")).toBe(false);
  });
});

describe("pre-expiry warnings", () => {
  async function disableWithDeadline(days: number, lead: number) {
    await publishCrmTariff();
    await activateCrm();
    await retention.saveRetentionPolicy({
      kind: "app",
      key: "crm",
      autoPurgeEnabled: true,
      retentionDays: days,
      notificationLeadDays: lead,
    });
    await activation.disableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: at(60),
    });
  }

  async function warnings() {
    const { rows } = await db.query<{ event_key: string; dedupe_key: string }>(
      `SELECT event_key, dedupe_key FROM notification_events
        WHERE business_id = $1 AND event_key = 'service.retention_expiring'`,
      [BUSINESS_A],
    );
    return rows;
  }

  it("warns once when the deadline enters the policy's lead window", async () => {
    await disableWithDeadline(7, 3);
    const disabledAt = at(60);

    // Two days in: still outside the three-day lead, so nothing yet.
    const early = await retention.notifyRetentionWarnings(
      new Date(disabledAt.getTime() + 2 * 24 * 3_600_000),
    );
    expect(early.notified).toBe(0);
    expect(await warnings()).toHaveLength(0);

    // Five days in: one warning, and only one — however often the tick runs.
    const due = new Date(disabledAt.getTime() + 5 * 24 * 3_600_000);
    expect((await retention.notifyRetentionWarnings(due)).notified).toBe(1);
    // The notification's UNIQUE dedupe key wins: the retry sees the candidate,
    // but only the first pass actually inserts/sends it.
    expect((await retention.notifyRetentionWarnings(due)).notified).toBe(0);
    const rows = await warnings();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toMatch(/^service-retention:/);
  });

  it("never warns for a suspension, because it has no deadline at all", async () => {
    await publishCrmTariff();
    await activateCrm();
    await retention.saveRetentionPolicy({
      kind: "app",
      key: "crm",
      autoPurgeEnabled: true,
      retentionDays: 7,
      notificationLeadDays: 3,
    });
    await db.query(`UPDATE business_wallets SET balance_rial = 1_000 WHERE business_id = $1`, [BUSINESS_A]);
    await activation.settleDueServiceRuntime({ now: at(120) });
    const suspended = await activation.getServiceActivation(BUSINESS_A, {
      kind: "app",
      key: "crm",
    });
    expect(suspended?.retentionDeadline).toBeNull();
    const run = await retention.notifyRetentionWarnings(new Date(at(120).getTime() + 30 * 24 * 3_600_000));
    expect(run.scanned).toBe(0);
    expect(await warnings()).toHaveLength(0);
  });

  it("does not warn after the data is gone or once a re-enable cancelled the purge", async () => {
    await disableWithDeadline(7, 3);
    const disabledAt = at(60);
    const due = new Date(disabledAt.getTime() + 5 * 24 * 3_600_000);

    await activation.reenableService({
      businessId: BUSINESS_A,
      identity: { kind: "app", key: "crm" },
      now: new Date(disabledAt.getTime() + 24 * 3_600_000),
    });
    expect((await retention.notifyRetentionWarnings(due)).scanned).toBe(0);
    expect(await warnings()).toHaveLength(0);
  });
});

describe("wizard state", () => {
  it("resumes with a version bump and is separate from first-run setup", async () => {
    const first = await activation.saveServiceWizardState({
      businessId: BUSINESS_A,
      identity: { kind: "workspace", key: "projects" },
      step: "basics",
      progress: { name: "پروژهٔ نمونه" },
    });
    expect(first.version).toBe(1);

    const second = await activation.saveServiceWizardState({
      businessId: BUSINESS_A,
      identity: { kind: "workspace", key: "projects" },
      step: "members",
      progress: { name: "پروژهٔ نمونه", members: 3 },
      completed: true,
    });
    expect(second.version).toBe(2);
    expect(second.completedAt).not.toBeNull();

    // It lives in the service's own table, never in the business's first-run
    // onboarding state (PR #838's `progress.completedAt`).
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM business_service_wizard_state
        WHERE business_id = $1 AND service_kind = 'workspace' AND service_key = 'projects'`,
      [BUSINESS_A],
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
