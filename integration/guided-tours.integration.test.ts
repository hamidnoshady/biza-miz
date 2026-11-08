/**
 * Issue #972 — the authored tour catalogue against a real migrated database
 * (CI only).
 *
 * The unit suite proves the rules (`tour-studio.test.ts`) and the HTTP contract
 * (`route.test.ts`) with the database replaced. What only a database can prove
 * is the part the epic's promise rests on:
 *
 *  - a **draft is invisible** to members, and publishing is what reveals it;
 *  - editing a published tour does **not** change what members play until it is
 *    published again (the live pointer is its own revision);
 *  - a **rollback appends** a new version with the old content, so the tour id
 *    and its step ids — what `tour_member_progress` is keyed on — survive;
 *  - archiving hides a tour without losing its history, and only a
 *    never-published draft can be deleted;
 *  - two editors saving from the same version cannot silently overwrite each
 *    other (`version_conflict`).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { TOUR_ANCHORS } from "../src/lib/tours";
import type { StudioTourContent } from "../src/lib/tour-studio";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/tour-studio-service");
let toursService: typeof import("../src/lib/tours-service");
let evidence: typeof import("../src/lib/tour-evidence-service");

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
  databaseName = `pos_tours_${randomUUID().replaceAll("-", "")}`;
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
  service = await import("../src/lib/tour-studio-service");
  toursService = await import("../src/lib/tours-service");
  evidence = await import("../src/lib/tour-evidence-service");

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
  await db.query("DELETE FROM knowledge_tour_revisions");
  await db.query("DELETE FROM knowledge_tours");
});

const PAGE = "page:/crm/audit";
const ROUTE = "/crm/audit";
const ACTOR = "admin-1";

function content(patch: Partial<StudioTourContent> = {}): StudioTourContent {
  return {
    tourKey: "studio.crm.audit",
    pageKey: PAGE,
    route: ROUTE,
    title: "سابقهٔ تصمیم‌ها",
    description: "تور دست‌نویس",
    eligibility: {},
    steps: [
      { id: "intro", kind: "explain", title: "شروع", body: "این صفحه تصمیم‌ها را نشان می‌دهد." },
      { id: "header", kind: "spotlight", anchor: TOUR_ANCHORS.pageHeader, title: "سرصفحه", body: "." },
    ],
    ...patch,
  };
}

describe("authoring a tour in the console", () => {
  it("keeps a draft invisible until it is published", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    expect(saved.created).toBe(true);
    expect(saved.version).toBe(1);

    expect(await service.publishedToursForPage(PAGE)).toEqual([]);
    expect(await service.publishedTourById("studio.crm.audit")).toBeNull();

    const draft = await service.getStudioTour(saved.id);
    expect(draft).toMatchObject({ status: "draft", version: 1, publishedVersion: null });

    await service.publishStudioTour(saved.id, ACTOR, 1);
    const published = await service.publishedToursForPage(PAGE);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: "studio.crm.audit",
      pageKey: PAGE,
      route: ROUTE,
      title: "سابقهٔ تصمیم‌ها",
      version: 1,
    });
    expect(published[0].steps.map((step) => step.id)).toEqual(["intro", "header"]);
    expect((await service.publishedTourById("studio.crm.audit"))?.steps).toHaveLength(2);
  });

  it("does not change what members play when a published tour is edited", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    await service.publishStudioTour(saved.id, ACTOR, 1);

    const edited = await service.saveStudioTour(
      content({ title: "عنوان ویرایش‌شده" }),
      ACTOR,
      saved.version,
    );
    expect(edited.version).toBe(2);

    // The console sees the unpublished change; members keep the live revision.
    const tour = await service.getStudioTour(saved.id);
    expect(tour).toMatchObject({ status: "published", version: 2, publishedVersion: 1 });
    expect((await service.publishedToursForPage(PAGE))[0]).toMatchObject({
      title: "سابقهٔ تصمیم‌ها",
      version: 1,
    });

    await service.publishStudioTour(saved.id, ACTOR, 2);
    expect((await service.publishedToursForPage(PAGE))[0]).toMatchObject({
      title: "عنوان ویرایش‌شده",
      version: 2,
    });
  });

  it("refuses to overwrite a newer edit (version_conflict), and keeps every revision", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    await service.saveStudioTour(content({ title: "ویرایش دوم" }), ACTOR, saved.version);

    await expect(service.saveStudioTour(content({ title: "ویرایش کهنه" }), ACTOR, 1)).rejects.toMatchObject({
      code: "version_conflict",
    });

    const revisions = await service.listStudioTourRevisions(saved.id);
    expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(revisions[0].title).toBe("ویرایش دوم");
  });

  it("rolls back by appending the old content as a new, live revision", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    await service.publishStudioTour(saved.id, ACTOR, 1);
    await service.saveStudioTour(content({ title: "نسخهٔ دوم" }), ACTOR, 1);
    await service.publishStudioTour(saved.id, ACTOR, 2);
    expect((await service.publishedToursForPage(PAGE))[0].title).toBe("نسخهٔ دوم");

    const restored = await service.rollbackStudioTour(saved.id, 1, ACTOR);
    expect(restored.version).toBe(3);
    expect(restored.publishedVersion).toBe(3);
    expect(restored.title).toBe("سابقهٔ تصمیم‌ها");

    // Append-only history: the edit that was undone is still there to see.
    const revisions = await service.listStudioTourRevisions(saved.id);
    expect(revisions.map((revision) => revision.version)).toEqual([3, 2, 1]);
    expect(revisions[0].live).toBe(true);
    expect(revisions[1].title).toBe("نسخهٔ دوم");
    expect(revisions[2].title).toBe("سابقهٔ تصمیم‌ها");

    const live = await service.publishedToursForPage(PAGE);
    expect(live[0]).toMatchObject({ title: "سابقهٔ تصمیم‌ها", version: 3 });
    // The step ids are the ones members may already have seen.
    expect(live[0].steps.map((step) => step.id)).toEqual(["intro", "header"]);
  });

  it("hides an archived tour from members without deleting its history", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    await service.publishStudioTour(saved.id, ACTOR, 1);
    const archived = await service.archiveStudioTour(saved.id, ACTOR);
    expect(archived.status).toBe("archived");
    expect(await service.publishedToursForPage(PAGE)).toEqual([]);
    expect(await service.listStudioTourRevisions(saved.id)).toHaveLength(1);

    // Publishing it again is allowed and returns it to members.
    await service.publishStudioTour(saved.id, ACTOR, archived.version);
    expect(await service.publishedToursForPage(PAGE)).toHaveLength(1);
  });

  it("deletes only a never-published draft", async () => {
    const draft = await service.saveStudioTour(content({ tourKey: "studio.crm.draft" }), ACTOR);
    await service.deleteStudioTourDraft(draft.id);
    expect(await service.getStudioTour(draft.id)).toBeNull();

    const published = await service.saveStudioTour(content(), ACTOR);
    await service.publishStudioTour(published.id, ACTOR, 1);
    await expect(service.deleteStudioTourDraft(published.id)).rejects.toMatchObject({
      code: "not_draft",
    });
    expect(await service.getStudioTour(published.id)).not.toBeNull();
  });

  it("skips a stored tour whose page or anchor no longer exists", async () => {
    const saved = await service.saveStudioTour(content(), ACTOR);
    await service.publishStudioTour(saved.id, ACTOR, 1);
    // Simulate a row left behind by a renamed page / removed anchor.
    await db.query(
      `UPDATE knowledge_tour_revisions
          SET steps = $2::jsonb
        WHERE tour_id = $1 AND version = 1`,
      [
        saved.id,
        JSON.stringify([
          { id: "intro", kind: "explain", title: "x", body: "." },
          { id: "gone", kind: "spotlight", anchor: "retired.anchor", title: "x", body: "." },
        ]),
      ],
    );
    expect(await service.publishedToursForPage(PAGE)).toEqual([]);
    expect(await service.publishedTourById("studio.crm.audit")).toBeNull();
  });

  it("lists the catalogue for the console with its working copy", async () => {
    await service.saveStudioTour(content({ tourKey: "studio.b" }), ACTOR);
    await service.saveStudioTour(content({ tourKey: "studio.a" }), ACTOR);
    const tours = await service.listStudioTours();
    expect(tours.map((tour) => tour.tourKey)).toEqual(["studio.a", "studio.b"]);
    expect(tours[0].status).toBe("draft");
  });
});

/**
 * Verified business actions (phase 2) — the table, the RLS and the completion
 * rule, against the real schema. A member can only ever be credited for their
 * own action in their own business, and a step completes on that evidence, not
 * on a request that merely says it happened.
 */
describe("verified action evidence", () => {
  let businessId = "";
  let userId = "";
  let otherBusinessId = "";

  beforeAll(async () => {
    const inserted = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Tours Co', $1) RETURNING id",
      [`tours-${randomUUID().slice(0, 8)}`],
    );
    businessId = inserted.rows[0].id;
    otherBusinessId = (
      await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
        [`other-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id;
    userId = (
      await db.query<{ id: string }>(
        "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id",
        [businessId],
      )
    ).rows[0].id;
  });

  beforeEach(async () => {
    await db.query("DELETE FROM tour_action_evidence");
    await db.query("DELETE FROM tour_member_progress");
  });

  it("counts repeats of the same action instead of logging every one", async () => {
    await dbLib.withTenantTransaction(businessId, async () => {
      await evidence.recordTourEvidence({ businessId, userId, verifier: "product.created", entityId: "item-1" });
      await evidence.recordTourEvidence({ businessId, userId, verifier: "product.created", entityId: "item-2" });
    });
    const record = await dbLib.withTenantTransaction(businessId, () =>
      evidence.hasTourEvidence(businessId, userId, "product.created"),
    );
    expect(record?.count).toBe(2);
    expect(record?.verifier).toBe("product.created");
  });

  it("is invisible to another business, even for the same member id", async () => {
    await dbLib.withTenantTransaction(businessId, () =>
      evidence.recordTourEvidence({ businessId, userId, verifier: "order.created" }),
    );
    const foreign = await dbLib.withTenantTransaction(otherBusinessId, () =>
      evidence.hasTourEvidence(otherBusinessId, userId, "order.created"),
    );
    expect(foreign).toBeNull();
  });

  it("completes the step only after the evidence row exists", async () => {
    const tour = (await import("../src/lib/tours")).tourById("crm.directory.first-customer")!;
    const step = tour.steps.find((entry) => entry.kind === "action")!;

    const before = await dbLib.withTenantTransaction(businessId, () =>
      toursService.verifyTourStep(businessId, userId, tour, step.id),
    );
    expect(before).toEqual({ ok: false, error: "evidence_missing" });

    await dbLib.withTenantTransaction(businessId, () =>
      evidence.recordTourEvidence({ businessId, userId, verifier: "party.created" }),
    );

    const after = await dbLib.withTenantTransaction(businessId, () =>
      toursService.verifyTourStep(businessId, userId, tour, step.id),
    );
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.progress?.seenStepIds).toContain(step.id);
      // The row exists exactly once, and it belongs to the caller.
      const rows = await db.query("SELECT user_id, verifier FROM tour_action_evidence WHERE verifier = 'party.created'");
      expect(rows.rows).toEqual([{ user_id: userId, verifier: "party.created" }]);
    }
  });

  it("refuses to verify a step that asks for nothing real", async () => {
    const tour = (await import("../src/lib/tours")).tourById("crm.directory.first-customer")!;
    const explain = tour.steps[0];
    const result = await dbLib.withTenantTransaction(businessId, () =>
      toursService.verifyTourStep(businessId, userId, tour, explain.id),
    );
    expect(result).toEqual({ ok: false, error: "not_verifiable" });
  });
});
