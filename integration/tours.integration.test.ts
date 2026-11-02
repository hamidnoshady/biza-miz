/**
 * Issue #972 — guided-tour progress, against a real database.
 *
 * `src/lib/tours.test.ts` proves the transition rules. This proves what only
 * Postgres can: that two devices writing at once both land (the row lock),
 * that progress belongs to one member of one business and no other, that a
 * reset removes only the caller's own row, and that a rejected event leaves
 * no placeholder row behind.
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
let service: typeof import("../src/lib/tours-service");
let tours: typeof import("../src/lib/tours");

const alpha = { businessId: "", ownerId: "", staffId: "" };
const beta = { businessId: "", ownerId: "" };

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
  service = await import("../src/lib/tours-service");
  tours = await import("../src/lib/tours");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
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

async function seedBusiness(slug: string, industry: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
    [slug, slug, industry],
  );
  const businessId = biz.rows[0].id;
  const user = async (role: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO users (business_id, role, full_name, email, password_hash)
         VALUES ($1, $2, $4, $3, 'x') RETURNING id`,
        [businessId, role, `${role}-${slug}@example.test`, role],
      )
    ).rows[0].id;
  return { businessId, ownerId: await user("owner"), staffId: await user("manager") };
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness(`alpha-${randomUUID().slice(0, 8)}`, "cosmetics"));
  const other = await seedBusiness(`beta-${randomUUID().slice(0, 8)}`, "food_service");
  beta.businessId = other.businessId;
  beta.ownerId = other.ownerId;
});

const tour = () => tours.tourById("accounting.products.list")!;
const stepIds = () => tour().steps.map((s) => s.id);

describe("tour progress storage", () => {
  it("stores what a member has seen and reads it back", async () => {
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "start" });
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: stepIds()[0] });
    const stored = (await dbLib.withTenant(alpha.businessId, () =>
      service.loadTourProgress(alpha.businessId, alpha.ownerId, [tour().id]),
    )).get(tour().id)!;
    expect(stored.seenStepIds).toEqual([stepIds()[0]]);
    expect(stored.currentStepId).toBe(stepIds()[1]);
    expect(tours.tourProgressView(tour(), stored).status).toBe("in_progress");
  });

  it("keeps progress per member and per business", async () => {
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: stepIds()[0] });
    const mine = await dbLib.withTenant(alpha.businessId, () =>
      service.loadTourProgress(alpha.businessId, alpha.ownerId, [tour().id]),
    );
    const colleague = await dbLib.withTenant(alpha.businessId, () =>
      service.loadTourProgress(alpha.businessId, alpha.staffId, [tour().id]),
    );
    const otherBusiness = await dbLib.withTenant(beta.businessId, () =>
      service.loadTourProgress(beta.businessId, beta.ownerId, [tour().id]),
    );
    expect(mine.size).toBe(1);
    expect(colleague.size).toBe(0);
    expect(otherBusiness.size).toBe(0);
  });

  it("lands both events when two devices write at once", async () => {
    const [first, second, third] = stepIds();
    await Promise.all([
      service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: first }),
      service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: second }),
      service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: third }),
    ]);
    const stored = (await service.loadTourProgress(alpha.businessId, alpha.ownerId, [tour().id])).get(tour().id)!;
    expect([...stored.seenStepIds].sort()).toEqual([first, second, third].sort());
    const rows = await db.query("SELECT 1 FROM tour_member_progress WHERE business_id = $1", [alpha.businessId]);
    expect(rows.rowCount).toBe(1);
  });

  it("completes only once every step was seen, and a replay does not lower it", async () => {
    const early = await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "complete" });
    expect(early).toEqual({ ok: false, error: "steps_unseen" });
    for (const stepId of stepIds()) {
      await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId });
    }
    const done = await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "complete" });
    expect(done.ok && done.progress?.completedAt).toBeTruthy();
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "start" });
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "pause", stepId: stepIds()[2] });
    const stored = (await service.loadTourProgress(alpha.businessId, alpha.ownerId, [tour().id])).get(tour().id)!;
    expect(tours.tourProgressView(tour(), stored).status).toBe("completed");
  });

  it("leaves no row behind after a rejected first event", async () => {
    const result = await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: "nope" });
    expect(result).toEqual({ ok: false, error: "unknown_step" });
    const rows = await db.query("SELECT 1 FROM tour_member_progress WHERE business_id = $1", [alpha.businessId]);
    expect(rows.rowCount).toBe(0);
  });

  it("resets only the caller's own row", async () => {
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "step_seen", stepId: stepIds()[0] });
    await service.recordTourEvent(alpha.businessId, alpha.staffId, tour(), { type: "step_seen", stepId: stepIds()[0] });
    const reset = await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "reset" });
    expect(reset).toEqual({ ok: true, progress: null });
    const rows = await db.query<{ user_id: string }>("SELECT user_id FROM tour_member_progress WHERE business_id = $1", [alpha.businessId]);
    expect(rows.rows.map((r) => r.user_id)).toEqual([alpha.staffId]);
  });

  it("resolves the industry that gates eligibility from the business, not the request", async () => {
    const inventory = new Set<string>(["inventory.view"]);
    const id = tour().id;
    expect((await service.eligibleTourById(id, alpha.businessId, inventory))?.id).toBe(id);
    expect(await service.eligibleTourById(id, beta.businessId, inventory)).toBeNull();
    expect(await service.eligibleTourById(id, alpha.businessId, new Set())).toBeNull();
    expect(await service.eligibleTourById("unknown.tour", alpha.businessId, inventory)).toBeNull();
  });

  it("is removed with its business", async () => {
    await service.recordTourEvent(alpha.businessId, alpha.ownerId, tour(), { type: "start" });
    await db.query("DELETE FROM businesses WHERE id = $1", [alpha.businessId]);
    const rows = await db.query("SELECT 1 FROM tour_member_progress WHERE business_id = $1", [alpha.businessId]);
    expect(rows.rowCount).toBe(0);
  });
});
