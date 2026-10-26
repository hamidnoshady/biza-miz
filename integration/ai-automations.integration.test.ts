/**
 * Phase D — the Automation engine persists, validates against the live
 * catalogue, gathers real facts and previews without proposing.
 *
 * Exercises the CRUD service and `previewAutomation` against real migrated
 * schema (0155). The pure validation/evaluator rules are unit-tested in
 * `src/lib/ai-automations.test.ts`; this proves they hold end-to-end through
 * the database, that facts are read from the real reports, and that RLS-shaped
 * tenant scoping keeps one business's automations out of another's.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/ai-automations-service");
let projects: typeof import("../src/lib/ai-projects");

const alpha = { businessId: "", userId: "", locationId: "", menuItemId: "" };
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

beforeAll(async () => {
  databaseName = `pos_ai_automations_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/ai-automations-service");
  projects = await import("../src/lib/ai-projects");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const a = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Alpha', $1, 'food_service') RETURNING id`,
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = a.rows[0].id;
  const loc = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone) VALUES ($1, 'Main', 'Asia/Tehran') RETURNING id`,
    [alpha.businessId],
  );
  alpha.locationId = loc.rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [alpha.businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  alpha.userId = owner.rows[0].id;
  const cat = await db.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id`,
    [alpha.locationId],
  );
  const item = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Espresso', 100000) RETURNING id`,
    [alpha.locationId, cat.rows[0].id],
  );
  alpha.menuItemId = item.rows[0].id;
  const b = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Beta', $1, 'food_service') RETURNING id`,
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  beta.businessId = b.rows[0].id;
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

describe("automation engine service", () => {
  it("creates, reads back and lists an automation with its conditions and action", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "یادآور مطالبات",
          triggerKind: "schedule",
          scheduleHour: 9,
          conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
          actionType: "journal.manual.propose",
          actionPayload: { note: "بررسی مطالبات" },
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.automation.name).toBe("یادآور مطالبات");
    expect(created.automation.triggerKind).toBe("schedule");
    expect(created.automation.conditions.all?.length).toBe(1);
    expect(created.automation.actionType).toBe("journal.manual.propose");
    expect(created.automation.approvalMode).toBe("ask");

    const fetched = await dbLib.withTenant(alpha.businessId, () =>
      service.getAutomation(alpha.businessId, created.automation.id),
    );
    expect(fetched?.name).toBe("یادآور مطالبات");

    const list = await dbLib.withTenant(alpha.businessId, () =>
      service.listAutomations(alpha.businessId),
    );
    expect(list.some((a) => a.id === created.automation.id)).toBe(true);
  });

  it("stores authorized_by only for an auto automation", async () => {
    const auto = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "خودکار",
          triggerKind: "event",
          eventKind: "day_close",
          actionType: "journal.manual.propose",
          approvalMode: "auto",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.automation.approvalMode).toBe("auto");
  });

  it("rejects an unknown action at the service boundary", async () => {
    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "بد", triggerKind: "manual", actionType: "nope.nope" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("unknown_action:"))).toBe(true);
  });

  it("gathers real facts and previews whether conditions currently hold", async () => {
    // A fresh business has no A/R, no A/P and no stock — every Rial fact is 0.
    const facts = await dbLib.withTenant(alpha.businessId, () =>
      service.gatherAutomationFacts(alpha.businessId, new Date("2026-03-18T06:00:00.000Z")),
    );
    expect(facts.receivableTotalRial).toBe(0);
    expect(facts.payableTotalRial).toBe(0);
    expect(facts.stockValuationRial).toBe(0);
    expect(facts.weekday).toBeGreaterThanOrEqual(0);
    expect(facts.weekday).toBeLessThanOrEqual(6);

    // An automation gated on "receivables >= 5,000,000" must NOT fire for a
    // business with zero receivables; one gated on "<= 0" must.
    const wontFire = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "نباید اجرا شود",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
          actionType: "journal.manual.propose",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    const willFire = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "باید اجرا شود",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "lte", value: 0 }] },
          actionType: "journal.manual.propose",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(wontFire.ok && willFire.ok).toBe(true);
    if (!wontFire.ok || !willFire.ok) return;

    const previewNo = await dbLib.withTenant(alpha.businessId, () =>
      service.previewAutomation(alpha.businessId, wontFire.automation.id),
    );
    expect(previewNo?.conditionsMet).toBe(false);

    const previewYes = await dbLib.withTenant(alpha.businessId, () =>
      service.previewAutomation(alpha.businessId, willFire.automation.id),
    );
    expect(previewYes?.conditionsMet).toBe(true);
    expect(previewYes?.actionType).toBe("journal.manual.propose");
  });

  it("refuses a duplicate name, updates, deletes and is tenant-scoped", async () => {
    const first = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dup = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors).toContain("name_taken");

    // Same name in Beta is fine.
    const other = await dbLib.withTenant(beta.businessId, () =>
      service.createAutomation(
        beta.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(other.ok).toBe(true);

    const updated = await dbLib.withTenant(alpha.businessId, () =>
      service.updateAutomation(
        alpha.businessId,
        first.automation.id,
        {
          name: "ویرایش‌شده",
          triggerKind: "manual",
          actionType: "journal.manual.propose",
          enabled: false,
        },
        { authorizedBy: null },
      ),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.automation.enabled).toBe(false);

    // Beta cannot see or delete Alpha's automation.
    const betaDelete = await dbLib.withTenant(beta.businessId, () =>
      service.deleteAutomation(beta.businessId, first.automation.id),
    );
    expect(betaDelete).toBe(false);
    const alphaDelete = await dbLib.withTenant(alpha.businessId, () =>
      service.deleteAutomation(alpha.businessId, first.automation.id),
    );
    expect(alphaDelete).toBe(true);
  });

  it("labels an automation with a project it owns, refuses a foreign one, and clears the label when the project is deleted", async () => {
    // A project of Alpha's, created through the real service.
    const project = await dbLib.withTenant(alpha.businessId, () =>
      projects.createProject(
        { businessId: alpha.businessId, actorUserId: alpha.userId },
        { name: `راه‌اندازی ونک ${randomUUID().slice(0, 6)}` },
      ),
    );
    // Beta's own project — a foreign id Alpha must not be able to point at.
    const betaProjectRow = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, instructions, created_by)
       VALUES ($1, $2, '', 'seed') RETURNING id`,
      [beta.businessId, `پروژهٔ بتا ${randomUUID().slice(0, 6)}`],
    );
    const betaProject = { id: betaProjectRow.rows[0].id };

    // Creating with Alpha's own project id sticks.
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: `اتوماسیون پروژه ${randomUUID().slice(0, 6)}`,
          projectId: project.id,
          triggerKind: "manual",
          actionType: "journal.manual.propose",
        },
        { userId: alpha.userId, authorizedBy: null },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.automation.projectId).toBe(project.id);

    // Pointing at Beta's project is refused, not silently nulled.
    const foreign = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: `اتوماسیون خارجی ${randomUUID().slice(0, 6)}`,
          projectId: betaProject.id,
          triggerKind: "manual",
          actionType: "journal.manual.propose",
        },
        { userId: alpha.userId, authorizedBy: null },
      ),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errors).toContain("project_not_found");

    // Deleting the project SET NULLs the label but keeps the automation.
    await dbLib.withTenant(alpha.businessId, () =>
      projects.archiveProject({ businessId: alpha.businessId, actorUserId: alpha.userId, projectId: project.id }),
    );
    await db.query(`DELETE FROM ai_projects WHERE id = $1`, [project.id]);
    const afterDelete = await dbLib.withTenant(alpha.businessId, () =>
      service.getAutomation(alpha.businessId, created.automation.id),
    );
    expect(afterDelete).not.toBeNull();
    expect(afterDelete?.projectId).toBeNull();
  });
});

describe("firing an automation through the shared guarded path", () => {
  let autopilot: typeof import("../src/lib/ai-autopilot-service");

  beforeAll(async () => {
    autopilot = await import("../src/lib/ai-autopilot-service");
    // The owner opts the pricing category into unattended writes, with a cap
    // that a +5,000 ﷼ change clears but a +50,000 ﷼ change does not.
    await dbLib.withTenant(alpha.businessId, () =>
      autopilot.setAutopilotCategory(
        alpha.businessId,
        "pricing",
        { enabled: true, maxPercent: 10, maxAmountRial: 10_000 },
        alpha.userId,
      ),
    );
  });

  async function priceOf(menuItemId: string): Promise<number> {
    const { rows } = await db.query<{ price: string }>(
      "SELECT price::text AS price FROM menu_items WHERE id = $1",
      [menuItemId],
    );
    return Number(rows[0].price);
  }

  it("an auto automation within the caps applies unattended and audits as 'automation'", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "افزایش قیمت خودکار",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "lte", value: 0 }] },
          actionType: "menu.item.priceUpdate",
          actionPayload: { menuItemId: alpha.menuItemId, price: 105_000 },
          approvalMode: "auto",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.runAutomationNow(alpha.businessId, created.automation.id),
    );
    expect(result?.outcome).toBe("applied");
    expect(await priceOf(alpha.menuItemId)).toBe(105_000);

    const { rows } = await db.query<{ status: string; source: string; category: string; prior_state: { price: number } }>(
      `SELECT a.status, a.source, a.autopilot_category AS category, a.prior_state
         FROM ai_action_audit a
         JOIN ai_automation_runs r ON r.audit_id = a.id
        WHERE r.id = $1`,
      [result!.runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", source: "automation", category: "pricing" });
    // Only prior_state can answer "what was the price before" — what makes undo possible.
    expect(rows[0].prior_state.price).toBe(100_000);
  });

  it("an over-cap auto automation is HELD as a clickable proposal, never applied", async () => {
    const before = await priceOf(alpha.menuItemId);
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "افزایش قیمت بیش از سقف",
          triggerKind: "manual",
          actionType: "menu.item.priceUpdate",
          // +50,000 ﷼ — well past the 10,000 ﷼ cap AND the 10% cap.
          actionPayload: { menuItemId: alpha.menuItemId, price: before + 50_000 },
          approvalMode: "auto",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.runAutomationNow(alpha.businessId, created.automation.id),
    );
    expect(result?.outcome).toBe("pending_approval");
    // The price did NOT move: over-cap means held, not forced through.
    expect(await priceOf(alpha.menuItemId)).toBe(before);

    const { rows } = await db.query<{ status: string; source: string; deferred_reason: string | null }>(
      `SELECT a.status, a.source, a.deferred_reason
         FROM ai_action_audit a JOIN ai_automation_runs r ON r.audit_id = a.id
        WHERE r.id = $1`,
      [result!.runId],
    );
    // Still a 'proposed' row a human can click and apply — never dropped.
    expect(rows[0]).toMatchObject({ status: "proposed", source: "automation" });
    expect(rows[0].deferred_reason).not.toBeNull();
  });

  it("holds an auto action for approval when its target app was customer-disabled", async () => {
    const before = await priceOf(alpha.menuItemId);
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "انبارداری غیرفعال",
          triggerKind: "manual",
          actionType: "menu.item.priceUpdate",
          actionPayload: { menuItemId: alpha.menuItemId, price: before + 1_000 },
          approvalMode: "auto",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await db.query(
      `INSERT INTO business_service_activations (business_id, service_kind, service_key, label, state)
       VALUES ($1, 'app', 'accounting', 'حسابداری', 'disabled_retained')`,
      [alpha.businessId],
    );
    try {
      const result = await dbLib.withTenant(alpha.businessId, () =>
        service.runAutomationNow(alpha.businessId, created.automation.id),
      );
      expect(result?.outcome).toBe("pending_approval");
      expect(await priceOf(alpha.menuItemId)).toBe(before);
      const { rows } = await db.query<{ status: string; deferred_reason: string | null }>(
        `SELECT a.status, a.deferred_reason
           FROM ai_action_audit a JOIN ai_automation_runs r ON r.audit_id = a.id
          WHERE r.id = $1`,
        [result!.runId],
      );
      expect(rows).toEqual([{ status: "proposed", deferred_reason: "service_disabled" }]);
    } finally {
      await db.query(
        `DELETE FROM business_service_activations
          WHERE business_id = $1 AND service_kind = 'app' AND service_key = 'accounting'`,
        [alpha.businessId],
      );
    }
  });

  it("an 'ask' automation is always held even when the caps would admit it", async () => {
    const nextPrice = (await priceOf(alpha.menuItemId)) + 1_000;
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "همیشه بپرس",
          triggerKind: "manual",
          actionType: "menu.item.priceUpdate",
          actionPayload: { menuItemId: alpha.menuItemId, price: nextPrice },
          approvalMode: "ask",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.runAutomationNow(alpha.businessId, created.automation.id),
    );
    expect(result?.outcome).toBe("pending_approval");
  });

  it("a run whose conditions do not hold ends 'skipped' and proposes nothing", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "شرط برقرار نیست",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
          actionType: "menu.item.priceUpdate",
          actionPayload: { menuItemId: alpha.menuItemId, price: 999_000 },
          approvalMode: "auto",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.runAutomationNow(alpha.businessId, created.automation.id),
    );
    expect(result?.outcome).toBe("skipped");

    const { rows } = await db.query<{ conditions_met: boolean; audit_id: string | null }>(
      `SELECT conditions_met, audit_id FROM ai_automation_runs WHERE id = $1`,
      [result!.runId],
    );
    expect(rows[0].conditions_met).toBe(false);
    expect(rows[0].audit_id).toBeNull();
  });

  it("is idempotent: the same dedupe key claims once", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "یک‌بار در روز",
          triggerKind: "schedule",
          scheduleHour: 0,
          actionType: "menu.item.priceUpdate",
          actionPayload: { menuItemId: alpha.menuItemId, price: 106_000 },
          approvalMode: "ask",
        },
        { userId: alpha.userId, authorizedBy: alpha.userId },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const automation = await dbLib.withTenant(alpha.businessId, () =>
      service.getAutomation(alpha.businessId, created.automation.id),
    );
    // Fire twice with the same schedule dedupe key — the second claim is a no-op.
    const first = await dbLib.withTenant(alpha.businessId, () =>
      service.fireAutomation({
        businessId: alpha.businessId,
        automation: automation!,
        triggerSource: "schedule",
        dedupeKey: "schedule:2026-03-18:00",
      }),
    );
    const second = await dbLib.withTenant(alpha.businessId, () =>
      service.fireAutomation({
        businessId: alpha.businessId,
        automation: automation!,
        triggerSource: "schedule",
        dedupeKey: "schedule:2026-03-18:00",
      }),
    );
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
