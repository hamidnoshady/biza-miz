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
 * 7. **A queue opens as the rows it counted.** The card says «۶ مورد» and shows
 *    four; the other two are reachable only if the link it renders is a filter
 *    that screen's own parser accepts *and* returns the same rows. The last block
 *    asks the service for the rows each link names and demands they be the
 *    queue's own — a count a reader cannot open is a number they must trust.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  dealViewOwnerUserId,
  dealViewQuery,
  dealViewRialBounds,
  dealViewUnownedOnly,
  parseDealViewFilters,
} from "../src/lib/crm-deal-views";
import {
  caseViewListOptions,
  caseViewQuery,
  parseCaseViewFilters,
} from "../src/lib/crm-case-views";
import {
  activityViewListOptions,
  parseActivityViewFilters,
} from "../src/lib/crm-activity-views";

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
let leadService: typeof import("../src/lib/crm-lead-service");
let day: typeof import("../src/lib/business-day-service");

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
  leadService = await import("../src/lib/crm-lead-service");
  day = await import("../src/lib/business-day-service");

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
    // The shop's own today, the date `crmQueues` judges every row against —
    // the same precaution the «opens each openable queue» block below takes,
    // and for a failure this block actually suffered: built from the runner's
    // clock instead, «تماس امروز» was written at 23:00 UTC, whose *business*
    // date is already tomorrow once Tehran passes midnight. Between 20:30 and
    // 24:00 UTC the row therefore read as overdue and the queue counted seven,
    // so the suite was green or red by time of day.
    const today = await day.businessToday(biz.id);
    const dayOffset = (offset: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

    for (let index = 0; index < 6; index += 1) {
      await makeActivity(biz.id, {
        subject: `تماس عقب‌افتادهٔ ${index}`,
        dueAt: `${dayOffset(-(index + 2))}T09:00:00Z`,
      });
    }
    // Due today is a different queue: an activity whose due date is today must
    // not appear in «عقب‌افتاده», or the two headings say the same thing.
    await makeActivity(biz.id, {
      subject: "تماس امروز",
      dueAt: `${today}T09:00:00Z`,
    });
    // A completed one is not outstanding work at all.
    await makeActivity(biz.id, {
      subject: "تماس انجام‌شده",
      dueAt: `${dayOffset(-3)}T09:00:00Z`,
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

describe("a saved deal view is the filters the screen honours", () => {
  /**
   * The deals board declared seven filter keys and honoured one of them, so a
   * shared view was stored faithfully and applied partially — the shape
   * `docs/crm-relationship-os.md` calls a lie. These pin every key end to end:
   * the vocabulary (`crm-deal-views.ts`) parses the same query the screen sends,
   * `listDeals` narrows on it in SQL, and a view stored through the service
   * round-trips into the request the board makes.
   */
  it("narrows on every key, in SQL, with the units the screen uses", async () => {
    // A business of its own: the file's shared one already holds the deals the
    // stage tests created, so "the filter excluded the other deals" would prove
    // nothing there.
    const own = await createBusiness("ros-deal-views");
    const viewer = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'owner', 'بیننده', $2, 'x') RETURNING id`,
      [own.businessId, `viewer-${randomUUID().slice(0, 7)}@example.test`],
    );
    const viewerId = viewer.rows[0].id;
    const pipeline = await pipelines.defaultPipeline(own.businessId);
    const openStage = pipeline!.stages.find((stage) => stage.outcome === "open")!;
    const wonStage = pipeline!.stages.find((stage) => stage.outcome === "won")!;
    const customer = await makeParty(own.businessId, "مشتری فیلترها");
    const otherCustomer = await makeParty(own.businessId, "مشتری دیگر");

    const mine = await crm.upsertDeal(own.businessId, {
      title: "معاملهٔ من",
      customerId: customer,
      stageId: openStage.id,
      valueRial: 50_000_000,
      ownerUserId: viewerId,
      createdBy: actor.name,
    });
    const theirs = await crm.upsertDeal(own.businessId, {
      title: "معاملهٔ بی‌صاحب",
      customerId: otherCustomer,
      stageId: openStage.id,
      valueRial: 5_000_000,
      createdBy: actor.name,
    });
    const closed = await crm.upsertDeal(own.businessId, {
      title: "معاملهٔ بسته",
      customerId: customer,
      stageId: wonStage.id,
      valueRial: 90_000_000,
      createdBy: actor.name,
    });

    const run = async (query: Record<string, string>) => {
      const parsed = parseDealViewFilters({ get: (key) => query[key] ?? null });
      expect(parsed.error).toBeNull();
      const bounds = dealViewRialBounds(parsed.filters);
      const deals = await crm.listDeals(own.businessId, {
        stageId: parsed.filters.stageId || undefined,
        pipelineId: parsed.filters.pipelineId || undefined,
        q: parsed.filters.q || undefined,
        ownerUserId: dealViewOwnerUserId(parsed.filters, viewerId),
        unowned: dealViewUnownedOnly(parsed.filters),
        minValueRial: bounds.minValueRial,
        maxValueRial: bounds.maxValueRial,
        openOnly: parsed.filters.openOnly,
      });
      return deals.map((deal) => deal.id);
    };

    // Each key on its own, and the amount converted from Toman exactly once.
    // Sorted, because the row *set* is what these filters decide; the ordering
    // (`updated_at DESC, id`) is pinned by the board's own tests.
    const ids = (found: string[]) => [...found].sort();
    expect(ids(await run({ owner: "mine" }))).toEqual(ids([mine.id]));
    expect(ids(await run({ owner: "none" }))).toEqual(ids([theirs.id, closed.id]));
    expect(ids(await run({ stageId: openStage.id }))).toEqual(ids([mine.id, theirs.id]));
    expect(await run({ pipelineId: pipeline!.id })).toHaveLength(3);
    // A pipeline that is not this one excludes them all — the filter is a real
    // narrowing, not a parameter the query happened to ignore.
    expect(await run({ pipelineId: randomUUID() })).toEqual([]);
    expect(ids(await run({ q: "بی‌صاحب" }))).toEqual(ids([theirs.id]));
    expect(ids(await run({ q: "مشتری فیلترها" }))).toEqual(ids([mine.id, closed.id]));
    // The typed bound is Toman and the column is Rial: «۱٬۰۰۰٬۰۰۰ تومان» is
    // 10,000,000 Rial, which keeps the 50,000,000- and 90,000,000-rial deals and
    // drops the 5,000,000-rial one. A bound converted on the wrong side of that
    // border would match nothing at all, which is the failure nobody reports.
    expect(ids(await run({ minValue: "1000000" }))).toEqual(ids([mine.id, closed.id]));
    expect(ids(await run({ maxValue: "1000000" }))).toEqual(ids([theirs.id]));
    // Open means "not terminal by outcome", so a business whose won column is
    // not named `won` still gets the right rows.
    expect(ids(await run({ open: "1" }))).toEqual(ids([mine.id, theirs.id]));
    // And the filters compose: mine, open, at least «۱ تومان».
    expect(ids(await run({ owner: "mine", open: "1", minValue: "1" }))).toEqual(ids([mine.id]));
    expect(await run({ owner: "mine", open: "1", maxValue: "1" })).toEqual([]);

    // `mine` for a caller with no member id is nobody — never everybody.
    const asNobody = parseDealViewFilters({ get: () => null });
    expect(dealViewOwnerUserId(asNobody.filters, null)).toBeNull();
  });

  it("round-trips a view saved through the service into the request the board sends", async () => {
    const saved = await views.saveView(
      biz.id,
      {
        entity: "deals",
        name: "معامله‌های بزرگ من",
        filters: { owner: "mine", minValue: "1000000", open: "1" },
        shared: true,
      },
      { name: "مدیر", userId: biz.userId },
    );
    expect(saved.ok).toBe(true);
    const view = saved.ok ? saved.view : null;
    expect(view?.filters).toEqual({ owner: "mine", minValue: "1000000", open: "1" });

    // The screen serialises the stored document into the query, and the server
    // parses that query with the same module: three readings, one answer.
    const query = dealViewQuery({
      q: "",
      stageId: "",
      pipelineId: "",
      owner: view!.filters.owner,
      openOnly: view!.filters.open === "1",
      minToman: Number(view!.filters.minValue),
      maxToman: null,
    });
    expect(query).toEqual({ owner: "mine", open: "1", minValue: "1000000" });
    const parsed = parseDealViewFilters({ get: (key) => query[key] ?? null });
    expect(parsed.filters.owner).toBe("mine");
    expect(dealViewRialBounds(parsed.filters).minValueRial).toBe(10_000_000);

    // A key the vocabulary does not carry is dropped rather than stored, so a
    // view can never promise a filter the board cannot apply.
    const withUnknown = await views.saveView(
      biz.id,
      {
        entity: "deals",
        name: "نما با کلید ناشناس",
        filters: { owner: "mine", forecast: "high" },
        shared: true,
      },
      { name: "مدیر", userId: biz.userId },
    );
    expect(withUnknown.ok && withUnknown.view.filters).toEqual({ owner: "mine" });

    // An impossible value inside the vocabulary is refused, not stored.
    const bad = await views.saveView(
      biz.id,
      {
        entity: "deals",
        name: "نما با مرحلهٔ نامعتبر",
        filters: { stageId: "miz" },
        shared: true,
      },
      { name: "مدیر", userId: biz.userId },
    );
    // Refused *and named*: the screen can point at the stage control, which is
    // the difference between a fixable mistake and a mystery.
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toBe("invalid_filters");
    expect(bad.ok === false && bad.field).toBe("stageId");
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


describe("every floor surface assigns a member, not a name", () => {
  /**
   * The deals board got a member picker first; activities, tickets and leads
   * kept a free-text field. These pin the same contract on all four, because
   * "who owns this?" has to mean one thing: an id that resolves to somebody who
   * can sign in, with the name kept beside it as the row's snapshot.
   */
  async function makeMember(name: string, isActive = true): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash, is_active)
       VALUES ($1, 'manager', $2, $3, 'x', $4) RETURNING id`,
      [biz.id, name, `floor-${randomUUID().slice(0, 8)}@example.test`, isActive],
    );
    return rows[0].id;
  }

  it("writes the id and the name together on a task", async () => {
    const memberId = await makeMember("سارا نوری");
    const activity = await crm.createActivity(biz.id, {
      kind: "call",
      subject: "تماس پیگیری",
      assigneeUserId: memberId,
      createdBy: actor.name,
    });
    expect(activity.assigneeUserId).toBe(memberId);
    expect(activity.assignedTo).toBe("سارا نوری");
  });

  it("resolves a typed name for a task, and declines to guess between two", async () => {
    const memberId = await makeMember("کاظم احمدی");
    const resolved = await crm.createActivity(biz.id, {
      kind: "call",
      subject: "کار با نام",
      assignedTo: "کاظم احمدی",
    });
    expect(resolved.assigneeUserId).toBe(memberId);

    await makeMember("نگار سلطانی");
    await makeMember("نگار سلطانی");
    const ambiguous = await crm.createActivity(biz.id, {
      kind: "call",
      subject: "کار نام تکراری",
      assignedTo: "نگار سلطانی",
    });
    // Unassigned, name kept: the row still says who was meant, and the
    // unassigned list is where a human decides.
    expect(ambiguous.assigneeUserId).toBeNull();
    expect(ambiguous.assignedTo).toBe("نگار سلطانی");
  });

  it("refuses a member of another business on a task", async () => {
    const foreign = new Client({ connectionString: urlFor(databaseName) });
    await foreign.connect();
    const { rows } = await foreign.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'بیگانهٔ کار', $2, 'x') RETURNING id`,
      [other.id, `foreign-task-${randomUUID().slice(0, 8)}@example.test`],
    );
    await foreign.end();

    const activity = await crm.createActivity(biz.id, {
      kind: "call",
      subject: "کار بیگانه",
      assigneeUserId: rows[0].id,
    });
    expect(activity.assigneeUserId).toBeNull();
    expect(activity.assignedTo).toBe("");
  });

  it("clears both columns when a task is unassigned", async () => {
    const memberId = await makeMember("بهنام رستمی");
    const activity = await crm.createActivity(biz.id, {
      kind: "call",
      subject: "کار واگذارشده",
      assigneeUserId: memberId,
    });
    const cleared = await crm.updateActivity(biz.id, activity.id, { assigneeUserId: "" });
    expect(cleared?.assigneeUserId).toBeNull();
    expect(cleared?.assignedTo).toBe("");
  });

  it("assigns a ticket on create and again on update", async () => {
    const first = await makeMember("حمید کاظمی");
    const second = await makeMember("لیلا شریفی");
    const created = await crm.upsertCase(biz.id, {
      subject: "تیکت واگذارشده",
      assigneeUserId: first,
      createdBy: actor.name,
    });
    expect(created.assigneeUserId).toBe(first);
    expect(created.assignedTo).toBe("حمید کاظمی");

    const moved = await crm.upsertCase(biz.id, {
      id: created.id,
      subject: "تیکت واگذارشده",
      assigneeUserId: second,
      createdBy: actor.name,
    });
    expect(moved.assigneeUserId).toBe(second);
    expect(moved.assignedTo).toBe("لیلا شریفی");
  });

  it("assigns a lead by id, which the list column could never be filled with before", async () => {
    const memberId = await makeMember("پویا مقدم");
    const lead = await leadService.saveLead(
      biz.id,
      { name: "سرنخ واگذارشده", ownerUserId: memberId },
      { name: actor.name, userId: actor.userId },
    );
    expect(lead?.ownerUserId).toBe(memberId);
    expect(lead?.ownerName).toBe("پویا مقدم");
  });

  it("lists my work by member id, not by a name two people can share", async () => {
    const mine = await makeMember("منِ کاربر");
    const namesake = await makeMember("منِ کاربر");
    await crm.createActivity(biz.id, { kind: "call", subject: "کار من", assigneeUserId: mine });
    await crm.createActivity(biz.id, { kind: "call", subject: "کار همنام", assigneeUserId: namesake });

    const listed = await crm.listActivities(biz.id, { assigneeUserId: mine, openOnly: true });
    const subjects = listed.map((row) => row.subject);
    expect(subjects).toContain("کار من");
    expect(subjects).not.toContain("کار همنام");

    const cases = await crm.listCases(biz.id, { assigneeUserId: mine });
    await crm.upsertCase(biz.id, { subject: "تیکت من", assigneeUserId: mine, createdBy: actor.name });
    const again = await crm.listCases(biz.id, { assigneeUserId: mine });
    expect(again.length).toBe(cases.length + 1);
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

describe("queues as views", () => {
  /**
   * A business of its own: the file's shared one carries other tests' rows, and
   * the question here is exactly which rows a queue's link names.
   */
  it("opens each openable queue on precisely the rows it counted", async () => {
    const own = await createBusiness("ros-queue-views");
    const member = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'زهرا کریمی', $2, 'x') RETURNING id`,
      [own.businessId, `queue-${randomUUID().slice(0, 7)}@example.test`],
    );
    const viewerId = member.rows[0].id;
    const customer = await makeParty(own.businessId, "مشتری صف‌ها");

    // The shop's own today — the date the queue's SQL and the list's bounds are
    // both judged by. Building the timestamps from it (rather than from the
    // browser's noon) is what makes «امروز» one date in both places.
    const today = await day.businessToday(own.businessId);
    const dayOffset = (offset: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

    // Two calls that are open, and two that are finished — the finished pair is
    // what a naive link would list: their due dates are in the past (and today),
    // and the card above them counts neither.
    await makeActivity(own.businessId, {
      subject: "تماس عقب‌افتاده",
      dueAt: `${dayOffset(-1)}T09:00:00Z`,
      customerId: customer,
    });
    await makeActivity(own.businessId, {
      subject: "تماس امروز",
      dueAt: `${today}T09:00:00Z`,
    });
    await makeActivity(own.businessId, {
      subject: "تماس دیروزِ انجام‌شده",
      dueAt: `${dayOffset(-1)}T09:00:00Z`,
      completed: true,
    });
    await makeActivity(own.businessId, {
      subject: "تماس امروزِ انجام‌شده",
      dueAt: `${today}T09:00:00Z`,
      completed: true,
    });

    const insertCase = async (input: {
      subject: string;
      status?: string;
      priority?: string;
      openedHoursAgo?: number;
      waitingSinceHoursAgo?: number;
      /** Hours after opening that the first reply went out. */
      firstResponseAfterHours?: number;
      /** Hours after opening that the ticket was resolved. */
      resolvedAfterHours?: number;
      assigneeUserId?: string;
      assignedTo?: string;
    }) => {
      const opened = input.openedHoursAgo ?? 0;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO crm_cases (
           business_id, customer_id, subject, status, priority,
           assignee_user_id, assigned_to,
           opened_at, waiting_since, first_response_at, resolved_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           now() - ($8 || ' hours')::interval,
           CASE WHEN $9::text IS NULL THEN NULL
                ELSE now() - ($9 || ' hours')::interval END,
           CASE WHEN $10::text IS NULL THEN NULL
                ELSE now() - (($8::numeric - $10::numeric) || ' hours')::interval END,
           CASE WHEN $11::text IS NULL THEN NULL
                ELSE now() - (($8::numeric - $11::numeric) || ' hours')::interval END
         ) RETURNING id`,
        [
          own.businessId,
          customer,
          input.subject,
          input.status ?? "open",
          input.priority ?? "normal",
          input.assigneeUserId ?? null,
          input.assignedTo ?? "",
          String(opened),
          input.waitingSinceHoursAgo === undefined ? null : String(input.waitingSinceHoursAgo),
          input.firstResponseAfterHours === undefined
            ? null
            : String(input.firstResponseAfterHours),
          input.resolvedAfterHours === undefined ? null : String(input.resolvedAfterHours),
        ],
      );
      return rows[0].id;
    };

    const breached = await insertCase({
      subject: "تیکت معوق",
      priority: "urgent",
      openedHoursAgo: 10,
      assigneeUserId: viewerId,
    });
    // Waiting on the customer, and nobody's: it belongs in both queues.
    const waiting = await insertCase({
      subject: "تیکت منتظر مشتری",
      status: "waiting",
      openedHoursAgo: 8,
      waitingSinceHoursAgo: 7,
    });
    const unowned = await insertCase({ subject: "تیکت بی‌مسئول", openedHoursAgo: 1 });
    // Answered **late** and then resolved. The response promise was missed, so
    // the clock still calls it breached — and the queue's own link (`open=1`)
    // is what keeps it off the list, because «خطر از دست رفتن مهلت» is about
    // risk that is still ahead and this case is finished.
    const resolvedLate = await insertCase({
      subject: "تیکت بستهٔ دیررسیده",
      status: "resolved",
      priority: "urgent",
      openedHoursAgo: 48,
      firstResponseAfterHours: 6,
      resolvedAfterHours: 30,
    });
    // Owned by a legacy free-text name and no member id. «بی‌مسئول» means
    // nobody, and that name is still a claim — so it is in neither the queue nor
    // the link. (`unowned_work` in the data-quality workspace reads it the same.)
    await insertCase({ subject: "تیکت با نام قدیمی", openedHoursAgo: 3, assignedTo: "حمید" });

    const all = await queues.crmQueues(own.businessId);
    const queue = (key: string) => all.find((entry) => entry.key === key)!;
    const ids = (found: string[]) => [...found].sort();

    // The activities queues, through the task list's own translation.
    const activities = async (document: Record<string, string>) => {
      const parsed = parseActivityViewFilters({ get: (key) => document[key] ?? null });
      expect(parsed.error).toBeNull();
      const rows = await crm.listActivities(
        own.businessId,
        activityViewListOptions(parsed.filters, { viewerId, today }),
      );
      return rows;
    };
    const overdue = queue("overdue_follow_ups");
    const overdueRows = await activities(overdue.view!.filters);
    expect(overdue.count).toBe(1);
    expect(ids(overdueRows.map((row) => row.id))).toEqual(ids(overdue.items.map((item) => item.id)));
    expect(overdueRows.map((row) => row.subject)).toEqual(["تماس عقب‌افتاده"]);

    const dueToday = queue("due_today");
    const dueTodayRows = await activities(dueToday.view!.filters);
    expect(dueToday.count).toBe(1);
    expect(dueTodayRows.map((row) => row.subject)).toEqual(["تماس امروز"]);

    // The case queues, through the service desk's own translation.
    const cases = async (document: Record<string, string>) => {
      const parsed = parseCaseViewFilters({ get: (key) => document[key] ?? null });
      expect(parsed.error).toBeNull();
      return crm.listCases(own.businessId, caseViewListOptions(parsed.filters, viewerId));
    };

    const risk = queue("sla_risk");
    const riskRows = await cases(risk.view!.filters);
    expect(risk.count).toBe(1);
    expect(ids(riskRows.map((row) => row.id))).toEqual(ids([breached]));
    // The witness for the `open` half: the resolved one *is* breached by the
    // clock (it answered after its target), and the queue's own link is what
    // keeps it off the list.
    const lateOnly = await crm.listCases(own.businessId, { breachedOnly: true });
    expect(ids(lateOnly.map((row) => row.id))).toEqual(ids([breached, resolvedLate]));

    const waitingQueue = queue("waiting_on_customer");
    const waitingRows = await cases(waitingQueue.view!.filters);
    expect(waitingQueue.count).toBe(1);
    expect(ids(waitingRows.map((row) => row.id))).toEqual(ids([waiting]));

    const unassignedQueue = queue("unassigned_cases");
    const unassignedRows = await cases(unassignedQueue.view!.filters);
    // Two, not three: the legacy-named ticket is not «بی‌مسئول», and the waiting
    // one is — a waiting case nobody owns is still nobody's.
    expect(unassignedQueue.count).toBe(2);
    expect(ids(unassignedRows.map((row) => row.id))).toEqual(ids([waiting, unowned]));

    // And the queues that cannot be opened say so, rather than carrying a link
    // that would open something else.
    for (const key of ["stalled_deals", "new_leads", "vip_follow_up", "possible_duplicates"]) {
      expect(queue(key).view, key).toBeNull();
    }
    for (const entry of all) {
      if (!entry.view) continue;
      expect(entry.view.href.startsWith("/crm/"), entry.key).toBe(true);
      expect(entry.view.href, entry.key).toContain("?");
    }
  });
});
