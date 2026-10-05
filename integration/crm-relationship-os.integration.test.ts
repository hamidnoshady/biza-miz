/**
 * The Relationship OS surfaces added after the audit: smart queues, the
 * canonical stage write path, the won-deal handoff to Accounting, saved views
 * and the CRM audit reader.
 *
 * Each block pins a property that is invisible until it breaks:
 *
 * 1. **A queue's count is a real count.** The overview once reported a page
 *    size as a total; a queue that says «۴ مورد» for a queue of six is the same
 *    bug, so the test asks for six and gets six while the preview stays four.
 * 2. **A queue that cannot be read is dropped, not fatal.** The home page has
 *    twelve rules behind it; one broken one must not blank the page.
 * 3. **`stageId` is the write path.** A business's own stage — one no legacy
 *    key can name — round-trips through `upsertDeal` into `stage_id`, and the
 *    legacy column is kept in step rather than becoming a second opinion.
 * 4. **Winning a deal posts nothing.** The handoff *links* an order that
 *    Accounting owns; the CRM never creates one, and a link cannot be made to
 *    another business's document.
 * 5. **The handoff is idempotent.** A retried request after a success must
 *    succeed again, and a *different* document on a linked deal must be
 *    refused rather than silently overwritten.
 * 6. **A saved view is private until shared**, and a built-in one is nobody's
 *    to rewrite or delete.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let queues: typeof import("../src/lib/crm-queues");
let crm: typeof import("../src/lib/crm-service");
let handoff: typeof import("../src/lib/crm-deal-handoff");
let pipelines: typeof import("../src/lib/crm-pipeline-service");
let views: typeof import("../src/lib/crm-saved-views-service");
let audit: typeof import("../src/lib/crm-audit-service");
let ownership: typeof import("../src/lib/crm-ownership");

const biz = { id: "", locationId: "", userId: "" };
const other = { id: "", locationId: "" };
const actor = { name: "مدیر فروش", userId: null as string | null };

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

async function makeParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles)
     VALUES ($1, $2, ARRAY['customer']::text[]) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

async function makeOrder(locationId: string, customerId: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
     VALUES ($1, $2, 'completed', 900000, 900000, now(), $3) RETURNING id`,
    [locationId, customerId, Math.floor(Math.random() * 1_000_000)],
  );
  return rows[0].id;
}

async function makeActivity(
  businessId: string,
  input: { subject: string; dueAt: string; completed?: boolean; customerId?: string | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_activities
       (business_id, customer_id, kind, subject, due_at, completed_at, assigned_to)
     VALUES ($1, $2, 'call', $3, $4::timestamptz, $5, '')
     RETURNING id`,
    [businessId, input.customerId ?? null, input.subject, input.dueAt, input.completed ? new Date().toISOString() : null],
  );
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_ros_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  queues = await import("../src/lib/crm-queues");
  crm = await import("../src/lib/crm-service");
  handoff = await import("../src/lib/crm-deal-handoff");
  pipelines = await import("../src/lib/crm-pipeline-service");
  views = await import("../src/lib/crm-saved-views-service");
  audit = await import("../src/lib/crm-audit-service");
  ownership = await import("../src/lib/crm-ownership");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const primary = await createBusiness("ros");
  biz.id = primary.businessId;
  biz.locationId = primary.locationId;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مدیر', $2, 'x') RETURNING id`,
    [biz.id, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  biz.userId = owner.rows[0].id;
  actor.userId = biz.userId;

  const secondary = await createBusiness("ros-other");
  other.id = secondary.businessId;
  other.locationId = secondary.locationId;
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

describe("smart queues", () => {
  it("counts the whole queue while previewing only the first few", async () => {
    for (let index = 0; index < 6; index += 1) {
      await makeActivity(biz.id, {
        subject: `تماس عقب‌افتادهٔ ${index}`,
        dueAt: new Date(Date.now() - (index + 2) * 86_400_000).toISOString(),
      });
    }
    // Due today is a different queue: an activity whose due date is today must
    // not appear in «عقب‌افتاده», or the two headings say the same thing.
    const today = new Date();
    await makeActivity(biz.id, {
      subject: "تماس امروز",
      dueAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 0, 0).toISOString(),
    });
    // A completed one is not outstanding work at all.
    await makeActivity(biz.id, {
      subject: "تماس انجام‌شده",
      dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      completed: true,
    });

    const all = await queues.crmQueues(biz.id);
    // Every key is present: a queue that throws is dropped with a log line, so
    // this equality is also what proves all twelve queries run against a real
    // schema — a typo in one of them fails here rather than on the home page.
    expect(all.map((queue) => queue.key)).toEqual([...queues.CRM_QUEUE_KEYS]);

    const overdue = all.find((queue) => queue.key === "overdue_follow_ups")!;
    expect(overdue.count).toBe(6);
    expect(overdue.items).toHaveLength(4);
    // Oldest first: the most overdue call is the one to make first.
    expect(overdue.items[0].title).toBe("تماس عقب‌افتادهٔ 5");
    expect(overdue.items[3].title).toBe("تماس عقب‌افتادهٔ 2");
    expect(overdue.why.length).toBeGreaterThan(0);
    expect(overdue.action.length).toBeGreaterThan(0);

    const dueToday = all.find((queue) => queue.key === "due_today")!;
    expect(dueToday.count).toBe(1);
    expect(dueToday.items[0].title).toBe("تماس امروز");

    // Every queue points somewhere inside the CRM; a row that linked into
    // Accounting would be a route the reader may not be allowed to take.
    for (const queue of all) {
      expect(queue.why.trim().length).toBeGreaterThan(0);
      for (const item of queue.items) expect(item.href.startsWith("/crm/")).toBe(true);
    }
  });

  it("narrows to a section's own queues", () => {
    expect(queues.queueKeysForSection("activities")).toEqual(["overdue_follow_ups", "due_today"]);
    expect(queues.queueKeysForSection("deals")).toEqual([
      "stalled_deals",
      "high_value_open",
      "departed_owner",
    ]);
    // An unknown section returns nothing rather than everything: a typo must
    // not turn a section header into a copy of the home page.
    expect(queues.queueKeysForSection("nonsense")).toEqual([]);
  });

  it("lists a stalled open deal, and never a closed one", async () => {
    const customer = await makeParty(biz.id, "مشتری راکد");
    const stalled = await crm.upsertDeal(biz.id, {
      customerId: customer,
      title: "معاملهٔ راکد",
      valueRial: 5_000_000,
      createdBy: actor.name,
    });
    // Ten days without a stage change is what «متوقف‌شده» means; reached by
    // backdating the clock the queue reads rather than sleeping for it.
    await db.query(
      `UPDATE crm_deals SET stage_entered_at = now() - interval '10 days',
              last_activity_at = now() - interval '10 days'
        WHERE business_id = $1 AND id = $2`,
      [biz.id, stalled.id],
    );
    const closed = await crm.upsertDeal(biz.id, {
      customerId: customer,
      title: "معاملهٔ برنده‌شدهٔ قدیمی",
      stage: "won",
      valueRial: 9_000_000,
      createdBy: actor.name,
    });
    await db.query(
      `UPDATE crm_deals SET stage_entered_at = now() - interval '40 days',
              last_activity_at = now() - interval '40 days'
        WHERE business_id = $1 AND id = $2`,
      [biz.id, closed.id],
    );

    const all = await queues.crmQueues(biz.id);
    const stalledQueue = all.find((queue) => queue.key === "stalled_deals")!;
    expect(stalledQueue.items.map((item) => item.title)).toContain("معاملهٔ راکد");
    expect(stalledQueue.items.map((item) => item.title)).not.toContain("معاملهٔ برنده‌شدهٔ قدیمی");
    // The row opens the deal it names, not the board: a queue that drops you
    // on a list of forty deals has prioritised nothing.
    for (const item of stalledQueue.items) expect(item.href).toMatch(/^\/crm\/deals\?deal=/);
  });
});

describe("canonical deal stages", () => {
  it("writes a business's own stage as a row, keeping the legacy column in step", async () => {
    const pipeline = await pipelines.defaultPipeline(biz.id);
    expect(pipeline).not.toBeNull();
    // A stage this business invented: it has no legacy key, which is the whole
    // reason `stageId` exists on the write path.
    const saved = await pipelines.savePipelineStages(
      biz.id,
      pipeline!.id,
      [
        ...pipeline!.stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          displayOrder: stage.displayOrder,
          defaultProbability: stage.defaultProbability,
          outcome: stage.outcome,
          isActive: stage.isActive,
          requirementNote: stage.requirementNote,
        })),
        {
          name: "پیگیری قرارداد سازمانی",
          displayOrder: pipeline!.stages.length + 1,
          defaultProbability: 40,
          outcome: "open" as const,
          isActive: true,
          requirementNote: "",
        },
      ],
      actor,
    );
    expect(saved.error).toBeUndefined();
    const custom = saved.pipeline!.stages.find((stage) => stage.name === "پیگیری قرارداد سازمانی")!;

    const deal = await crm.upsertDeal(biz.id, {
      title: "قرارداد سازمانی",
      stageId: custom.id,
      valueRial: 12_000_000,
      createdBy: actor.name,
    });
    expect(deal.stageId).toBe(custom.id);
    expect(deal.pipelineId).toBe(pipeline!.id);
    // The compatibility column is derived from the stage, never left to
    // disagree with it: `open` degrades to «lead».
    expect(deal.stage).toBe("lead");

    const { rows } = await db.query<{ stage_id: string; stage: string; entered: string }>(
      `SELECT stage_id, stage, stage_entered_at::text AS entered
         FROM crm_deals WHERE business_id = $1 AND id = $2`,
      [biz.id, deal.id],
    );
    expect(rows[0].stage_id).toBe(custom.id);
    expect(rows[0].stage).toBe("lead");
    expect(rows[0].entered).not.toBeNull();
  });

  it("moves the deal to another stage and bumps the entry clock", async () => {
    const pipeline = await pipelines.defaultPipeline(biz.id);
    const target = pipeline!.stages.find((stage) => stage.outcome === "won")!;
    const { rows: before } = await db.query<{ id: string }>(
      `SELECT id FROM crm_deals WHERE business_id = $1 AND title = 'قرارداد سازمانی'`,
      [biz.id],
    );
    await db.query(`UPDATE crm_deals SET stage_entered_at = now() - interval '5 days' WHERE id = $1`, [
      before[0].id,
    ]);

    const updated = await crm.upsertDeal(biz.id, {
      id: before[0].id,
      title: "قرارداد سازمانی",
      stageId: target.id,
      valueRial: 12_000_000,
      createdBy: actor.name,
    });
    expect(updated.stageId).toBe(target.id);
    expect(updated.stage).toBe("won");

    const { rows } = await db.query<{ stage_id: string; fresh: boolean; closed: boolean }>(
      `SELECT stage_id,
              stage_entered_at > now() - interval '1 minute' AS fresh,
              closed_at IS NOT NULL AS closed
         FROM crm_deals WHERE id = $1`,
      [before[0].id],
    );
    // The stage changed, so the clock restarts — «how long has it been here» is
    // the question the stale-deal queue is asked.
    expect(rows[0].stage_id).toBe(target.id);
    expect(rows[0].fresh).toBe(true);
    expect(rows[0].closed).toBe(true);
  });

  it("resolves a legacy key onto the default pipeline's stage", async () => {
    const customer = await makeParty(biz.id, "مشتری تلفنی");
    const deal = await crm.upsertDeal(biz.id, {
      customerId: customer,
      title: "معاملهٔ تلفنی",
      stage: "negotiation",
      valueRial: 1_000_000,
      createdBy: actor.name,
    });
    const pipeline = await pipelines.defaultPipeline(biz.id);
    const expected = pipeline!.stages.find((stage) => stage.legacyKey === "negotiation")!;
    expect(deal.stageId).toBe(expected.id);
    expect(deal.pipelineId).toBe(pipeline!.id);
  });
});

describe("won-deal handoff to Accounting", () => {
  it("reports what is missing instead of linking nothing", async () => {
    const stageless = await crm.upsertDeal(biz.id, {
      title: "معاملهٔ بدون مشتری",
      stage: "won",
      valueRial: 3_000_000,
      createdBy: actor.name,
    });
    const blocked = await handoff.prepareDealHandoff(biz.id, stageless.id);
    expect(blocked).not.toBeNull();
    expect(blocked!.blockers.map((blocker) => blocker.code)).toContain("no_customer");
    // Both missing facts at once: fixing the customer first should not reveal
    // a second blocker the screen could have shown to begin with.
    for (const blocker of blocked!.blockers) expect(blocker.message.trim().length).toBeGreaterThan(0);
    expect(blocked!.href).toContain("/accounting/invoices/new");
    // The suggestion is a suggestion: the invoice's own value comes from
    // Accounting, and the CRM says so rather than pre-filling a document.
    expect(blocked!.suggestedValueRial).toBe(3_000_000);
  });

  it("refuses an order that belongs to another business", async () => {
    const customer = await makeParty(biz.id, "مشتری سند");
    const deal = await crm.upsertDeal(biz.id, {
      customerId: customer,
      title: "معاملهٔ سند",
      stage: "won",
      valueRial: 4_000_000,
      createdBy: actor.name,
    });
    const foreignCustomer = await makeParty(other.id, "مشتری دیگر");
    const foreignOrder = await makeOrder(other.locationId, foreignCustomer);

    const result = await handoff.linkDealToSalesDocument(biz.id, deal.id, foreignOrder, actor);
    expect(result).toEqual({ ok: false, error: "order_not_found" });

    const ready = await handoff.prepareDealHandoff(biz.id, deal.id);
    expect(ready!.blockers.map((blocker) => blocker.code)).not.toContain("already_linked");
    expect(ready!.href).toContain(`customer=${customer}`);
    expect(ready!.href).toContain(`deal=${deal.id}`);
  });

  it("links the same document twice, and refuses a different one on a linked deal", async () => {
    const customer = await makeParty(biz.id, "مشتری پیوند");
    const deal = await crm.upsertDeal(biz.id, {
      customerId: customer,
      title: "معاملهٔ پیوند",
      stage: "won",
      valueRial: 7_000_000,
      createdBy: actor.name,
    });
    const order = await makeOrder(biz.locationId, customer);

    expect(await handoff.linkDealToSalesDocument(biz.id, deal.id, order, actor)).toEqual({ ok: true });
    // A retried request after a success must not fail: the caller cannot know
    // which attempt the server saw.
    expect(await handoff.linkDealToSalesDocument(biz.id, deal.id, order, actor)).toEqual({ ok: true });

    const linked = await handoff.prepareDealHandoff(biz.id, deal.id);
    // A linked deal is not "ready to become a sale" any more — it already is
    // one — and the screen says exactly that rather than offering the button
    // again.
    expect(linked!.blockers.map((blocker) => blocker.code)).toEqual(["already_linked"]);

    // The deal's own row carries the link; the handoff view reports readiness.
    const { rows: linkedRows } = await db.query<{ order_id: string }>(
      `SELECT order_id FROM crm_deals WHERE business_id = $1 AND id = $2`,
      [biz.id, deal.id],
    );
    expect(linkedRows[0].order_id).toBe(order);

    const otherOrder = await makeOrder(biz.locationId, customer);
    expect(await handoff.linkDealToSalesDocument(biz.id, deal.id, otherOrder, actor)).toEqual({
      ok: false,
      error: "already_linked",
    });

    // The link is an audit event, and it says who did it and that the CRM
    // posted nothing.
    const log = await audit.listCrmAuditEvents(biz.id, { entityId: deal.id });
    const linkEvent = log.events.find((event) => event.kind === "deal.sales_document_linked")!;
    expect(linkEvent).toBeTruthy();
    expect(linkEvent.detail).toMatchObject({ orderId: order, createdByCrm: false });
  });

  it("posts nothing to the ledger", async () => {
    // The strongest form of the rule: no table Accounting owns gained a row
    // from any of the handoff work above.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].count).toBe("0");
  });
});

describe("saved views", () => {
  it("keeps a private view private and a shared one shared", async () => {
    const someoneElse = randomUUID();
    const saved = await views.saveView(
      biz.id,
      { entity: "customers", name: "مشتریان بی‌خرید", filters: { lifecycle: "lost" }, shared: false },
      { name: "مدیر", userId: biz.userId },
    );
    expect(saved.ok).toBe(true);

    const mine = await views.listSavedViews(biz.id, "customers", biz.userId);
    expect(mine.map((view) => view.name)).toContain("مشتریان بی‌خرید");
    // `someoneElse` is not a row in `users`, and the query compares ids rather
    // than joining — so an unknown member simply sees nothing of it.
    const theirs = await views.listSavedViews(biz.id, "customers", someoneElse);
    expect(theirs.map((view) => view.name)).not.toContain("مشتریان بی‌خرید");

    // Rewriting somebody else's private view is refused.
    const foreign = await views.saveView(
      biz.id,
      { id: mine.find((view) => view.name === "مشتریان بی‌خرید")!.id, entity: "customers", name: "دزدیده", filters: {}, shared: false },
      { name: "دیگری", userId: someoneElse },
    );
    expect(foreign).toEqual({ ok: false, error: "forbidden" });

    const shared = await views.saveView(
      biz.id,
      { entity: "customers", name: "همهٔ مشتریان فعال", filters: {}, shared: true },
      { name: "مدیر", userId: biz.userId },
    );
    expect(shared.ok).toBe(true);
    const sharedForThem = await views.listSavedViews(biz.id, "customers", someoneElse);
    expect(sharedForThem.map((view) => view.name)).toContain("همهٔ مشتریان فعال");
  });

  it("never rewrites or deletes a built-in view", async () => {
    await db.query(
      `INSERT INTO crm_saved_views (business_id, entity, name, filters, is_builtin, created_by)
       VALUES ($1, 'customers', 'همهٔ مشتریان', '{}'::jsonb, true, '')`,
      [biz.id],
    );
    const builtin = (await views.listSavedViews(biz.id, "customers", biz.userId)).find(
      (view) => view.isBuiltin,
    )!;
    expect(builtin).toBeTruthy();

    const rewrite = await views.saveView(
      biz.id,
      { id: builtin.id, entity: "customers", name: "چیز دیگر", filters: {}, shared: true },
      { name: "مدیر", userId: biz.userId },
    );
    expect(rewrite).toEqual({ ok: false, error: "builtin_readonly" });
    expect(await views.deleteSavedView(biz.id, builtin.id, { userId: biz.userId })).toBe(false);
  });

  it("forgets a filter key the vocabulary does not know", async () => {
    const saved = await views.saveView(
      biz.id,
      {
        entity: "customers",
        name: "با فیلتر ناشناس",
        filters: { lifecycle: "at_risk", "drop table parties": true },
        shared: false,
      },
      { name: "مدیر", userId: biz.userId },
    );
    expect(saved.ok).toBe(true);
    // The unknown key is dropped rather than stored: nothing from a UI can
    // reach a query, and a stored view cannot become a SQL fragment later.
    expect(saved.ok && saved.view.filters).not.toHaveProperty("drop table parties");
    expect(saved.ok && saved.view.filters).toMatchObject({ lifecycle: "at_risk" });

    const id = saved.ok ? saved.view.id : "";
    expect(await views.deleteSavedView(biz.id, id, { userId: biz.userId })).toBe(true);
    expect(await views.deleteSavedView(biz.id, id, { userId: biz.userId })).toBe(false);
  });
});

describe("the pipeline's own audit trail", () => {
  it("records shaping a pipeline as its own kind, not as a deal that does not exist", async () => {
    const created = await pipelines.createPipeline(biz.id, { name: "قیف سازمانی" }, actor);
    expect(created.ok).toBe(true);
    const pipelineId = created.ok ? created.pipeline.id : "";

    const renamed = await pipelines.updatePipeline(biz.id, pipelineId, { name: "قیف پروژه‌ای" }, actor);
    expect(renamed.ok).toBe(true);

    const events = await audit.listCrmAuditEvents(biz.id, { entityType: "pipeline" });
    const kinds = events.events.map((event) => event.kind);
    expect(kinds).toContain("pipeline.created");
    expect(kinds).toContain("pipeline.updated");
    // The reader's filter offers the entity the writer used.
    expect(audit.isCrmAuditEntityType("pipeline")).toBe(true);
    for (const event of events.events) {
      if (event.entityId !== pipelineId) continue;
      expect(event.entityType).toBe("pipeline");
      expect(event.summary.trim().length).toBeGreaterThan(0);
    }
    // The default pipeline's stage reshape, done in the earlier block, is
    // recorded under its own id — not folded into the new pipeline's story.
    const stageEvents = await audit.listCrmAuditEvents(biz.id, { kind: "pipeline.stages_changed" });
    expect(stageEvents.events.length).toBeGreaterThan(0);
  });
});

describe("ownership is an id, and the snapshot is kept", () => {
  async function makeMember(name: string, isActive = true): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash, is_active)
       VALUES ($1, 'manager', $2, $3, 'x', $4) RETURNING id`,
      [biz.id, name, `member-${randomUUID().slice(0, 8)}@example.test`, isActive],
    );
    return rows[0].id;
  }

  it("assigns a deal to a member by id and keeps the display name", async () => {
    const memberId = await makeMember("زهرا کریمی");
    const deal = await crm.upsertDeal(biz.id, {
      title: "معاملهٔ واگذارشده",
      valueRial: 2_000_000,
      ownerUserId: memberId,
      createdBy: actor.name,
    });
    expect(deal.ownerUserId).toBe(memberId);
    expect(deal.ownerUser).toBe("زهرا کریمی");
  });

  it("resolves a legacy typed name when exactly one member matches", async () => {
    const memberId = await makeMember("حسین مرادی");
    const deal = await crm.upsertDeal(biz.id, {
      title: "معاملهٔ نام‌دار",
      valueRial: 1_000_000,
      // The pre-picker shape: a name, typed. It still lands on a member,
      // because the name matches exactly one.
      ownerUser: "حسین مرادی",
      createdBy: actor.name,
    });
    expect(deal.ownerUserId).toBe(memberId);
  });

  it("refuses to guess between two members with the same name", async () => {
    await makeMember("مریم رضایی");
    await makeMember("مریم رضایی");
    const deal = await crm.upsertDeal(biz.id, {
      title: "معاملهٔ نام تکراری",
      valueRial: 1_000_000,
      ownerUser: "مریم رضایی",
      createdBy: actor.name,
    });
    // Unassigned, with the typed name kept: a wrong owner is worse than none,
    // and the row still says who was meant.
    expect(deal.ownerUserId).toBeNull();
    expect(deal.ownerUser).toBe("مریم رضایی");
  });

  it("refuses a member of another business", async () => {
    const foreign = new Client({ connectionString: urlFor(databaseName) });
    await foreign.connect();
    const { rows } = await foreign.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'بیگانه', $2, 'x') RETURNING id`,
      [other.id, `foreign-${randomUUID().slice(0, 8)}@example.test`],
    );
    await foreign.end();

    const deal = await crm.upsertDeal(biz.id, {
      title: "معاملهٔ بیگانه",
      valueRial: 1_000_000,
      ownerUserId: rows[0].id,
      createdBy: actor.name,
    });
    expect(deal.ownerUserId).toBeNull();
    expect(deal.ownerUser).toBe("");
  });

  it("surfaces work owned by a departed member, and stops once it is reassigned", async () => {
    const departed = await makeMember("عضو غیرفعال", false);
    const active = await makeMember("عضو فعال");
    const customer = await makeParty(biz.id, "مشتری واگذارشده");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO crm_cases (business_id, customer_id, subject, status, priority, assigned_to, assignee_user_id, case_number)
       VALUES ($1, $2, 'تیکت جامانده', 'open', 'normal', 'عضو غیرفعال', $3, 9001) RETURNING id`,
      [biz.id, customer, departed],
    );

    const before = (await queues.crmQueues(biz.id)).find((queue) => queue.key === "departed_owner")!;
    expect(before.count).toBeGreaterThan(0);
    expect(before.items.map((item) => item.id)).toContain(rows[0].id);
    expect(before.why.length).toBeGreaterThan(0);
    for (const item of before.items) expect(item.href.startsWith("/crm/")).toBe(true);

    // Reassignment is what clears it — the queue is the prompt, not the actor.
    await db.query(`UPDATE crm_cases SET assignee_user_id = $2 WHERE id = $1`, [rows[0].id, active]);
    const after = (await queues.crmQueues(biz.id)).find((queue) => queue.key === "departed_owner")!;
    expect(after.items.map((item) => item.id)).not.toContain(rows[0].id);
  });

  it("offers inactive members for reassignment rather than hiding them", async () => {
    const departed = await makeMember("رفته از شرکت", false);
    const members = await ownership.listAssignableMembers(biz.id);
    const row = members.find((member) => member.id === departed)!;
    expect(row).toBeTruthy();
    expect(row.isActive).toBe(false);
    expect(await ownership.inactiveOwners(biz.id)).toEqual(
      expect.arrayContaining([{ id: departed, name: "رفته از شرکت" }]),
    );
  });

  it("backfills legacy names from migration 0199 without touching ambiguous ones", async () => {
    // The migration runs at database creation, before these rows existed, so
    // the backfill is exercised here against rows it has to match — and again
    // afterwards, to prove it is idempotent.
    const solo = await makeMember("تنها یک نفر");
    const { rows: legacy } = await db.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, stage, value_rial, owner_user)
       VALUES ($1, 'معاملهٔ قدیمی', 'lead', 0, 'تنها یک نفر') RETURNING id`,
      [biz.id],
    );
    const { rows: ambiguous } = await db.query<{ id: string }>(
      `INSERT INTO crm_deals (business_id, title, stage, value_rial, owner_user)
       VALUES ($1, 'معاملهٔ مبهم', 'lead', 0, 'مریم رضایی') RETURNING id`,
      [biz.id],
    );

    const sql = readFileSync(
      new URL("../migrations/0199_crm_owner_ids.sql", import.meta.url),
      "utf8",
    );
    await db.query(sql);
    await db.query(sql); // idempotent

    const { rows } = await db.query<{ id: string; owner_user_id: string | null; owner_user: string }>(
      `SELECT id, owner_user_id, owner_user FROM crm_deals WHERE id = ANY($1::uuid[])`,
      [[legacy[0].id, ambiguous[0].id]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(legacy[0].id)!.owner_user_id).toBe(solo);
    expect(byId.get(ambiguous[0].id)!.owner_user_id).toBeNull();
    // The text column is untouched in both cases: nothing is lost by tidying.
    expect(byId.get(ambiguous[0].id)!.owner_user).toBe("مریم رضایی");
  });
});
