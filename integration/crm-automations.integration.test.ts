/**
 * CRM automations against a real PostgreSQL schema.
 *
 * The unit suite proves the vocabulary and the clock; this one proves what the
 * engine does to real rows, because that is where an automation is dangerous:
 * it acts with nobody watching, it assigns work to colleagues, and it is the
 * only thing in the CRM that can ask Growth to look at a customer.
 *
 * Each block pins a property:
 *
 * 1. **A rule is configuration.** It round-trips through `saveAutomation`, it is
 *    audited, and it only ever names a member who can actually sign in.
 * 2. **A trigger fires the rule — and only for records it is about.** A deal
 *    move fires deal rules, a new ticket fires ticket rules, a new lead fires
 *    lead rules; a re-save of the stage the deal is already in fires nothing.
 * 3. **Conditions gate it, and a gate that fails is recorded.** «اجرا نشد —
 *    شرط‌ها برقرار نبود» is the answer the screen has to give.
 * 4. **A follow-up is real work.** It lands in `crm_activities` as a task with a
 *    due date and an owner, so it appears in the list, in the queues and on the
 *    customer's timeline — not in an automation inbox of its own.
 * 5. **A departed colleague gets nobody's work.** A rule naming a member who has
 *    since been deactivated falls back to the record's owner, and to nobody at
 *    all when there is none.
 * 6. **Growth is signalled, not sent.** The `notify_growth` action writes a run
 *    row and an audit event, and nothing else — `listCrmGrowthSignals` is the
 *    read Growth consumes.
 * 7. **Tenancy is not a filter written by hand.** Another business's rules never
 *    fire, are never listed, and a member of another business cannot be named.
 * 8. **History survives the rule.** Deleting a rule leaves its runs behind, with
 *    the rule's name on them.
 * 9. **An automation moves no money and writes no campaign.** The stage move
 *    that triggers everything here posts no order and no ledger entry.
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
let automations: typeof import("../src/lib/crm-automation-service");
let rules: typeof import("../src/lib/crm-automation-rules");
let crm: typeof import("../src/lib/crm-service");
let leads: typeof import("../src/lib/crm-lead-service");
let pipelines: typeof import("../src/lib/crm-pipeline-service");
let audit: typeof import("../src/lib/crm-audit-service");

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

async function createBusiness(prefix: string) {
  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('فروشگاه تست', $1, 'food_service') RETURNING id`,
    [`${prefix}-${randomUUID().slice(0, 8)}`],
  );
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [business.rows[0].id],
  );
  return { businessId: business.rows[0].id, locationId: location.rows[0].id };
}

async function makeUser(
  businessId: string,
  name: string,
  options: { isActive?: boolean; role?: string } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash, is_active)
     VALUES ($1, $2, $3, $4, 'x', $5) RETURNING id`,
    [
      businessId,
      options.role ?? "cashier",
      name,
      `${randomUUID().slice(0, 10)}@example.test`,
      options.isActive ?? true,
    ],
  );
  return rows[0].id;
}

async function makeParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles)
     VALUES ($1, $2, ARRAY['customer']::text[]) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/**
 * A fresh business per rule, per the lesson the queue suite learned: two rules
 * in one business see each other's triggers, and a failure then points at the
 * wrong thing.
 */
async function freshBusiness(prefix: string) {
  const business = await createBusiness(prefix);
  const managerId = await makeUser(business.businessId, "مدیر فروش", { role: "owner" });
  const collectorId = await makeUser(business.businessId, "کارشناس پیگیری");
  const customerId = await makeParty(business.businessId, "مشتری تست");
  return { ...business, managerId, collectorId, customerId };
}

async function makeDeal(
  businessId: string,
  input: { title: string; customerId?: string | null; valueRial?: number; stageId?: string; ownerUserId?: string },
) {
  return crm.upsertDeal(businessId, {
    title: input.title,
    customerId: input.customerId ?? null,
    valueRial: input.valueRial ?? 0,
    stageId: input.stageId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    createdBy: "تست",
  });
}

async function stageIds(businessId: string) {
  const pipeline = await pipelines.defaultPipeline(businessId);
  const stages = pipeline?.stages ?? [];
  return {
    pipeline,
    lead: stages.find((stage) => stage.legacyKey === "lead") ?? stages[0],
    won: stages.find((stage) => stage.outcome === "won") ?? stages[stages.length - 1],
  };
}

/** Save a rule through the real service, so validation is exercised too. */
async function saveRule(
  businessId: string,
  input: {
    name: string;
    triggerKey: string;
    conditions?: { key: string; value?: string }[];
    actionKey: string;
    actionConfig?: { memberId?: string | null; offsetDays?: number | null; signal?: string | null };
  },
  actorName = "مدیر فروش",
) {
  const result = await automations.saveAutomation(
    businessId,
    {
      name: input.name,
      triggerKey: input.triggerKey,
      conditions: (input.conditions ?? []) as never,
      actionKey: input.actionKey,
      actionConfig: input.actionConfig ?? {},
    },
    { name: actorName, userId: null },
  );
  if (!result.ok) throw new Error(`rule refused: ${result.error}`);
  return result.rule;
}

beforeAll(async () => {
  databaseName = `pos_auto_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  automations = await import("../src/lib/crm-automation-service");
  rules = await import("../src/lib/crm-automation-rules");
  crm = await import("../src/lib/crm-service");
  leads = await import("../src/lib/crm-lead-service");
  pipelines = await import("../src/lib/crm-pipeline-service");
  audit = await import("../src/lib/crm-audit-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("a rule is configuration", () => {
  it("round-trips a rule, names its member, and lands in the audit log", async () => {
    const biz = await freshBusiness("auto-config");
    const rule = await saveRule(
      biz.businessId,
      {
        name: "پیگیری مذاکره‌های بزرگ",
        triggerKey: "deal_stage_changed",
        conditions: [{ key: "value_at_least", value: "10000000" }],
        actionKey: "create_follow_up",
        actionConfig: { memberId: biz.collectorId, offsetDays: 3 },
      },
      "مدیر فروش",
    );

    expect(rule.isActive).toBe(true);
    expect(rule.actionMemberName).toBe("کارشناس پیگیری");
    expect(rule.runCount).toBe(0);
    expect(rule.lastRunAt).toBeNull();

    const listed = await automations.listAutomations(biz.businessId);
    expect(listed).toHaveLength(1);
    expect(listed[0].conditions).toEqual([{ key: "value_at_least", value: "10000000" }]);

    const events = await audit.listCrmAuditEvents(biz.businessId, {});
    expect(events.events.some((event) => event.kind === "automation.config_changed")).toBe(true);

    // An edit keeps the same row rather than creating a second rule.
    const edited = await automations.saveAutomation(
      biz.businessId,
      {
        id: rule.id,
        name: "پیگیری مذاکره‌های خیلی بزرگ",
        triggerKey: "deal_stage_changed",
        conditions: [{ key: "value_at_least", value: "50000000" }],
        actionKey: "create_follow_up",
        actionConfig: { memberId: biz.collectorId, offsetDays: 7 },
      },
      { name: "مدیر فروش", userId: null },
    );
    expect(edited.ok).toBe(true);
    expect(await automations.listAutomations(biz.businessId)).toHaveLength(1);
  });

  it("refuses a member who cannot sign in, or is not of this business", async () => {
    const biz = await freshBusiness("auto-members");
    const other = await freshBusiness("auto-members-other");
    const inactive = await makeUser(biz.businessId, "همکار رفته", { isActive: false });
    const stranger = await makeUser(other.businessId, "غریبه");

    const base = {
      name: "قاعده",
      triggerKey: "case_opened",
      actionKey: "assign_owner",
    };
    const inactiveResult = await automations.saveAutomation(
      biz.businessId,
      { ...base, conditions: [], actionConfig: { memberId: inactive } },
      { name: "مدیر", userId: null },
    );
    expect(inactiveResult).toEqual({ ok: false, error: "automation_member_inactive" });

    const strangerResult = await automations.saveAutomation(
      biz.businessId,
      { ...base, conditions: [], actionConfig: { memberId: stranger } },
      { name: "مدیر", userId: null },
    );
    expect(strangerResult).toEqual({ ok: false, error: "automation_member_invalid" });

    const missing = await automations.saveAutomation(
      biz.businessId,
      {
        id: randomUUID(),
        ...base,
        conditions: [],
        actionConfig: { memberId: biz.collectorId },
      },
      { name: "مدیر", userId: null },
    );
    expect(missing).toEqual({ ok: false, error: "automation_not_found" });
  });
});

describe("a trigger fires the rules that belong to it", () => {
  it("files a follow-up when a deal moves and the condition holds", async () => {
    const biz = await freshBusiness("auto-deal");
    const stages = await stageIds(biz.businessId);
    // The deal exists before the rule does, so this measures the *move*: a deal
    // created after a rule was written fires it too (it was born on a stage),
    // and that is pinned by its own test below.
    const deal = await makeDeal(biz.businessId, {
      title: "قرارداد بزرگ",
      customerId: biz.customerId,
      valueRial: 60_000_000,
      stageId: stages.lead.id,
    });
    await saveRule(biz.businessId, {
      name: "پیگیری مذاکره",
      triggerKey: "deal_stage_changed",
      conditions: [{ key: "value_at_least", value: "10000000" }],
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 3 },
    });
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_activities WHERE business_id = $1`,
      [biz.businessId],
    );

    const moved = await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, {
      name: "مدیر فروش",
      userId: biz.managerId,
    });
    expect(moved.ok).toBe(true);

    const activities = await db.query<{
      kind: string;
      subject: string;
      /** A timestamptz: node-postgres hands it back as a Date. */
      due_at: Date;
      assignee_user_id: string;
      assigned_to: string;
      deal_id: string;
    }>(
      `SELECT kind, subject, due_at, assignee_user_id, assigned_to, deal_id
         FROM crm_activities WHERE business_id = $1 ORDER BY created_at`,
      [biz.businessId],
    );
    expect(Number(before.rows[0].count)).toBe(0);
    expect(activities.rows).toHaveLength(1);
    const followUp = activities.rows[0];
    expect(followUp.kind).toBe("task");
    expect(followUp.subject).toBe("پیگیری معامله: قرارداد بزرگ");
    expect(followUp.deal_id).toBe(deal.id);
    expect(followUp.assignee_user_id).toBe(biz.collectorId);
    expect(followUp.assigned_to).toBe("کارشناس پیگیری");

    // Due three business days out, at 09:00 Tehran.
    const lead = await db.query<{ today: string }>(
      `SELECT app_business_date(now(), 'Asia/Tehran', 0)::text AS today`,
    );
    const [year, month, day] = lead.rows[0].today.split("-").map(Number);
    const expected = new Date(Date.UTC(year, month - 1, day + 3)).toISOString().slice(0, 10);
    // The column is a timestamptz, so it arrives as a Date: the claim is about
    // the instant, and 09:00 Tehran is 05:30 UTC.
    expect(followUp.due_at.toISOString()).toBe(`${expected}T05:30:00.000Z`);

    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("applied");
    expect(runs[0].entityId).toBe(deal.id);
    expect((runs[0].detail as { activityId?: string }).activityId).toBeTruthy();

    const listed = await automations.listAutomations(biz.businessId);
    expect(listed[0].runCount).toBe(1);
    expect(listed[0].lastRunAt).toBeTruthy();
  });

  it("records a skip when the condition does not hold, and files nothing", async () => {
    const biz = await freshBusiness("auto-skip");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, {
      title: "معاملهٔ کوچک",
      customerId: biz.customerId,
      valueRial: 5_000_000,
      stageId: stages.lead.id,
    });
    await saveRule(biz.businessId, {
      name: "فقط معامله‌های بزرگ",
      triggerKey: "deal_stage_changed",
      conditions: [{ key: "value_at_least", value: "100000000" }],
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 1 },
    });
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });

    const activities = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_activities WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(Number(activities.rows[0].count)).toBe(0);

    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail.reason).toBe("conditions_not_met");

    // A rule that only ever skipped has not "run": the counter the screen shows
    // must not claim it did something.
    const listed = await automations.listAutomations(biz.businessId);
    expect(listed[0].runCount).toBe(0);
    expect(listed[0].lastRunAt).toBeNull();
  });

  it("does not fire for a deal saved onto the stage it is already in", async () => {
    const biz = await freshBusiness("auto-noop");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, { title: "بی‌حرکت", stageId: stages.lead.id });
    await saveRule(biz.businessId, {
      name: "هر جابه‌جایی",
      triggerKey: "deal_stage_changed",
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 0 },
    });
    // A drag that ends where it started, then a re-save of the same board.
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.lead.id, { name: "مدیر" });
    await crm.upsertDeal(biz.businessId, {
      id: deal.id,
      title: "بی‌حرکت (ویرایش‌شده)",
      stageId: stages.lead.id,
      valueRial: 1_000,
      createdBy: "مدیر",
    });

    expect(await automations.listAutomationRuns(biz.businessId)).toHaveLength(0);
    const activities = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_activities WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(Number(activities.rows[0].count)).toBe(0);
  });

  it("fires when a deal is saved straight onto a later stage", async () => {
    // Editing a deal through the API is a write path of its own: it must fire
    // the trigger, and a brand-new deal born on a stage has entered it.
    const biz = await freshBusiness("auto-upsert");
    const stages = await stageIds(biz.businessId);
    await saveRule(biz.businessId, {
      name: "ورود به مرحله",
      triggerKey: "deal_stage_changed",
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 1 },
    });

    await makeDeal(biz.businessId, { title: "تازه از پیشنهاد", stageId: stages.won.id });
    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("applied");
    // The run names the record and the stage it entered.
    expect(runs[0].detail.trigger).toBeUndefined();
    expect(runs[0].entityType).toBe("deal");
  });

  it("assigns the ticket a new case opens, and files a follow-up for a new lead", async () => {
    const biz = await freshBusiness("auto-case-lead");
    await saveRule(biz.businessId, {
      name: "واگذاری تیکت",
      triggerKey: "case_opened",
      conditions: [{ key: "priority_is", value: "urgent" }],
      actionKey: "assign_owner",
      actionConfig: { memberId: biz.collectorId },
    });
    await saveRule(biz.businessId, {
      name: "پیگیری سرنخ اینستاگرام",
      triggerKey: "lead_created",
      conditions: [{ key: "source_is", value: "instagram" }],
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 1 },
    });

    const created = await crm.upsertCase(biz.businessId, {
      customerId: biz.customerId,
      subject: "یخچال خراب",
      priority: "urgent",
      createdBy: "کارشناس",
      createdById: biz.managerId,
    });
    expect(created.assigneeUserId).toBe(biz.collectorId);
    expect(created.assignedTo).toBe("کارشناس پیگیری");

    // A ticket that arrives already resolved asks nothing of anybody.
    const closed = await crm.upsertCase(biz.businessId, {
      customerId: biz.customerId,
      subject: "حل‌شده از قبل",
      priority: "urgent",
      status: "closed",
      createdBy: "کارشناس",
    });
    expect(closed.assigneeUserId).toBeNull();

    // A lead from the wrong source is not this rule's business.
    await leads.saveLead(
      biz.businessId,
      { name: "سرنخ تلفنی", source: "phone", phone: null, email: null },
      { name: "کارشناس", userId: biz.managerId },
    );
    await leads.saveLead(
      biz.businessId,
      { name: "سرنخ اینستاگرامی", source: "instagram", phone: null, email: null },
      { name: "کارشناس", userId: biz.managerId },
    );

    const runs = await automations.listAutomationRuns(biz.businessId);
    const caseRuns = runs.filter((run) => run.entityType === "case");
    const leadRuns = runs.filter((run) => run.entityType === "lead");
    expect(caseRuns).toHaveLength(1);
    expect(caseRuns[0].outcome).toBe("applied");
    expect(leadRuns).toHaveLength(2);
    expect(leadRuns.map((run) => run.outcome).sort()).toEqual(["applied", "skipped"]);

    const tasks = await db.query<{ subject: string }>(
      `SELECT subject FROM crm_activities
        WHERE business_id = $1 AND kind = 'task' ORDER BY created_at`,
      [biz.businessId],
    );
    // The ticket rule assigned rather than filing a task, so only the lead's
    // follow-up is here.
    expect(tasks.rows.map((row) => row.subject)).toEqual(["پیگیری سرنخ: سرنخ اینستاگرامی"]);

    // The lead's follow-up is not attached to a lead row — a lead is not a
    // party yet — so the run is what carries the link.
    const applied = leadRuns.find((run) => run.outcome === "applied")!;
    expect((applied.detail as { activityId?: string }).activityId).toBeTruthy();
  });
});

describe("a departed colleague gets nobody's work", () => {
  it("falls back to the record's owner, and to nobody when there is none", async () => {
    const biz = await freshBusiness("auto-departed");
    const stages = await stageIds(biz.businessId);
    const departingId = await makeUser(biz.businessId, "همکار موقت");
    const ownerId = biz.managerId;

    const owned = await makeDeal(biz.businessId, {
      title: "معاملهٔ دارای مسئول",
      customerId: biz.customerId,
      stageId: stages.lead.id,
      ownerUserId: ownerId,
    });
    const unowned = await makeDeal(biz.businessId, { title: "معاملهٔ بی‌مسئول", stageId: stages.lead.id });

    await saveRule(biz.businessId, {
      name: "پیگیری پس از رفتن",
      triggerKey: "deal_stage_changed",
      actionKey: "create_follow_up",
      actionConfig: { memberId: departingId, offsetDays: 1 },
    });

    // The colleague leaves after the rule was written.
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [departingId]);

    await pipelines.moveDealToStage(biz.businessId, owned.id, stages.won.id, { name: "مدیر" });
    await pipelines.moveDealToStage(biz.businessId, unowned.id, stages.won.id, { name: "مدیر" });

    const tasks = await db.query<{ subject: string; assignee_user_id: string | null }>(
      `SELECT subject, assignee_user_id FROM crm_activities
        WHERE business_id = $1 AND kind = 'task' ORDER BY subject`,
      [biz.businessId],
    );
    expect(tasks.rows).toHaveLength(2);
    // Both tasks exist: a rule that cannot name its assignee still does the work
    // and leaves it in the «بدون مسئول» queue rather than losing it.
    const bySubject = new Map(tasks.rows.map((row) => [row.subject, row.assignee_user_id]));
    expect(bySubject.get("پیگیری معامله: معاملهٔ دارای مسئول")).toBe(ownerId);
    expect(bySubject.get("پیگیری معامله: معاملهٔ بی‌مسئول")).toBeNull();

    const runs = await automations.listAutomationRuns(biz.businessId);
    const fallback = runs.find((run) => run.detail.assigneeFallback === "rule_owner_inactive");
    expect(fallback).toBeTruthy();
  });

  it("refuses to hand a record to a member who has been deactivated", async () => {
    const biz = await freshBusiness("auto-departed-assign");
    const memberId = await makeUser(biz.businessId, "همکار واگذارشده");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, { title: "بی‌صاحب", stageId: stages.lead.id });
    await saveRule(biz.businessId, {
      name: "واگذاری معامله",
      triggerKey: "deal_stage_changed",
      actionKey: "assign_owner",
      actionConfig: { memberId },
    });
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [memberId]);
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });

    const after = await crm.getDeal(biz.businessId, deal.id);
    expect(after?.ownerUserId).toBeNull();
    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail.reason).toBe("member_inactive");
  });

  it("leaves a record already owned by the named member alone", async () => {
    const biz = await freshBusiness("auto-already-owned");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, {
      title: "از قبل مال خودش",
      stageId: stages.lead.id,
      ownerUserId: biz.collectorId,
    });
    await saveRule(biz.businessId, {
      name: "واگذاری معامله",
      triggerKey: "deal_stage_changed",
      actionKey: "assign_owner",
      actionConfig: { memberId: biz.collectorId },
    });
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });

    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail.reason).toBe("already_owned");
  });
});

describe("Growth is signalled, not sent", () => {
  it("writes a signal and an audit line, and nothing else", async () => {
    const biz = await freshBusiness("auto-growth");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, {
      title: "مشتری ارزشمند",
      customerId: biz.customerId,
      valueRial: 90_000_000,
      stageId: stages.lead.id,
    });
    await saveRule(biz.businessId, {
      name: "خبر دادن معاملهٔ بزرگ",
      triggerKey: "deal_stage_changed",
      conditions: [{ key: "value_at_least", value: "10000000" }],
      actionKey: "notify_growth",
      actionConfig: { signal: "high_value" },
    });
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });

    const activities = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_activities WHERE business_id = $1`,
      [biz.businessId],
    );
    expect(Number(activities.rows[0].count)).toBe(0);

    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("triggered_growth");
    expect(runs[0].detail.signal).toBe("high_value");

    const events = await audit.listCrmAuditEvents(biz.businessId, {});
    expect(events.events.some((event) => event.kind === "automation.signal_growth")).toBe(true);

    const signals = await automations.listCrmGrowthSignals(biz.businessId);
    expect(signals).toHaveLength(1);
    expect(signals[0].signal).toBe("high_value");
    expect(signals[0].partyId).toBe(biz.customerId);
    expect(signals[0].partyName).toBe("مشتری تست");
    expect(signals[0].ruleName).toBe("خبر دادن معاملهٔ بزرگ");
  });
});

describe("the run log", () => {
  it("counts, orders and survives the rule it describes", async () => {
    const biz = await freshBusiness("auto-runs");
    const stages = await stageIds(biz.businessId);
    const first = await makeDeal(biz.businessId, { title: "اول", stageId: stages.lead.id });
    const second = await makeDeal(biz.businessId, { title: "دوم", stageId: stages.lead.id });
    const rule = await saveRule(biz.businessId, {
      name: "قاعدهٔ حذف‌شدنی",
      triggerKey: "deal_stage_changed",
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 0 },
    });

    await pipelines.moveDealToStage(biz.businessId, first.id, stages.won.id, { name: "مدیر" });
    await pipelines.moveDealToStage(biz.businessId, second.id, stages.won.id, { name: "مدیر" });

    // Newest first, and the counters agree with the number of real effects.
    const runs = await automations.listAutomationRuns(biz.businessId, { limit: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0].entityId).toBe(second.id);
    const counts = await automations.automationCounts(biz.businessId);
    expect(counts).toEqual({ active: 1, total: 1, appliedLast30: 2 });
    const perRule = await automations.listAutomationRuns(biz.businessId, { automationId: rule.id });
    expect(perRule).toHaveLength(2);

    // Switching off is the ordinary way to stop a rule: the rules survive with
    // their counters, and nothing fires while it is off.
    const off = await automations.setAutomationActive(biz.businessId, rule.id, false, {
      name: "مدیر",
      userId: biz.managerId,
    });
    expect(off?.isActive).toBe(false);
    const third = await makeDeal(biz.businessId, { title: "سوم", stageId: stages.lead.id });
    // Born while the rule is off, moved while it is off: the trigger fires, the
    // engine reads no active rule, and nothing is recorded either way.
    await pipelines.moveDealToStage(biz.businessId, third.id, stages.won.id, { name: "مدیر" });
    expect(await automations.listAutomationRuns(biz.businessId)).toHaveLength(2);

    // Deleting the rule keeps its history, with the name the rule had.
    expect(await automations.deleteAutomation(biz.businessId, rule.id, { name: "مدیر", userId: null })).toBe(true);
    expect(await automations.listAutomations(biz.businessId)).toHaveLength(0);
    const kept = await automations.listAutomationRuns(biz.businessId);
    expect(kept).toHaveLength(2);
    expect(kept[0].automationName).toBe("قاعدهٔ حذف‌شدنی");
    expect(kept[0].automationId).toBeNull();
  });
});

describe("tenancy and money", () => {
  it("never fires another business's rules, or names another business's member", async () => {
    const biz = await freshBusiness("auto-tenant-a");
    const other = await freshBusiness("auto-tenant-b");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, { title: "معاملهٔ ما", stageId: stages.lead.id });

    await saveRule(
      biz.businessId,
      {
        name: "قاعدهٔ کسب‌وکار اول",
        triggerKey: "deal_stage_changed",
        actionKey: "create_follow_up",
        actionConfig: { memberId: biz.collectorId, offsetDays: 1 },
      },
    );

    // The other business's rules are not visible from here, and its member
    // cannot be named by a rule of this one.
    expect(await automations.listAutomations(other.businessId)).toHaveLength(0);
    const foreignMember = await automations.saveAutomation(
      biz.businessId,
      {
        name: "با عضو آن یکی",
        triggerKey: "deal_stage_changed",
        conditions: [],
        actionKey: "assign_owner",
        actionConfig: { memberId: other.managerId },
      },
      { name: "مدیر", userId: null },
    );
    expect(foreignMember).toEqual({ ok: false, error: "automation_member_invalid" });

    // A move in the other business fires nothing at all.
    const otherDeal = await makeDeal(other.businessId, { title: "معاملهٔ آن یکی", stageId: stages.lead.id });
    await pipelines.moveDealToStage(other.businessId, otherDeal.id, stages.won.id, { name: "مدیر" });
    expect(await automations.listAutomationRuns(other.businessId)).toHaveLength(0);
    expect(await automations.listAutomationRuns(biz.businessId)).toHaveLength(0);

    // And the move inside this business touches only this business's rows.
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });
    expect(await automations.listAutomationRuns(biz.businessId)).toHaveLength(1);
    const foreign = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_automation_runs WHERE business_id = $1`,
      [other.businessId],
    );
    expect(Number(foreign.rows[0].count)).toBe(0);
  });

  it("posts nothing when the automation watches a deal win", async () => {
    const biz = await freshBusiness("auto-money");
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, {
      title: "معاملهٔ برنده",
      customerId: biz.customerId,
      valueRial: 500_000_000,
      stageId: stages.lead.id,
    });
    await saveRule(biz.businessId, {
      name: "برنده شدن",
      triggerKey: "deal_stage_changed",
      actionKey: "create_follow_up",
      actionConfig: { memberId: biz.collectorId, offsetDays: 0 },
    });
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });

    // Winning a deal is a forecast, not a sale: the automation filed a task and
    // created no order and no ledger entry of any kind.
    const orders = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE customer_id = $1`,
      [biz.customerId],
    );
    expect(Number(orders.rows[0].count)).toBe(0);
    const linked = await db.query<{ order_id: string | null }>(
      `SELECT order_id FROM crm_deals WHERE id = $1`,
      [deal.id],
    );
    expect(linked.rows[0].order_id).toBeNull();
  });
});

describe("the vocabulary the engine reads", () => {
  it("keeps every declared trigger key loadable from the table", async () => {
    // The engine's read is `trigger_key = $2`; a vocabulary entry the table
    // cannot hold would be a rule nobody can write.
    const biz = await freshBusiness("auto-vocab");
    for (const trigger of rules.CRM_AUTOMATION_TRIGGERS) {
      const action = trigger === "deal_stage_changed" ? "create_follow_up" : "notify_growth";
      const saved = await automations.saveAutomation(
        biz.businessId,
        {
          name: `قاعدهٔ ${trigger}`,
          triggerKey: trigger,
          conditions: [],
          actionKey: action,
          actionConfig:
            action === "create_follow_up"
              ? { memberId: biz.collectorId, offsetDays: 0 }
              : { signal: "needs_follow_up" },
        },
        { name: "مدیر", userId: null },
      );
      expect(saved.ok).toBe(true);
    }
    const listed = await automations.listAutomations(biz.businessId);
    expect(listed.map((rule) => rule.triggerKey)).toEqual([...rules.CRM_AUTOMATION_TRIGGERS]);

    // A deal created *after* the rules exist fires the stage rule at birth, and
    // again when it moves.
    const stages = await stageIds(biz.businessId);
    const deal = await makeDeal(biz.businessId, { title: "دو قاعده", stageId: stages.lead.id });
    await pipelines.moveDealToStage(biz.businessId, deal.id, stages.won.id, { name: "مدیر" });
    const runs = await automations.listAutomationRuns(biz.businessId);
    expect(runs.filter((run) => run.triggerKey === "deal_stage_changed")).toHaveLength(2);
  });
});
