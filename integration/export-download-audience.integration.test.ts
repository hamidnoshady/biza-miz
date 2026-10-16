/**
 * The download of a *stored* export, through the route a browser actually calls
 * (issue #947, TEAM-F01 revisited).
 *
 * The service-level cases in `data-transfer.integration.test.ts` prove the decision. This
 * file proves the whole path a person takes: `GET /api/data/exports` (the history, with
 * its per-row answer) and `GET /api/data/exports/[id]` (the download), driven with a real
 * signed session so the permission resolution, the audience derivation and the response
 * body are the ones production would produce. The failure this catches is the one the
 * first pass left open: the *route* deciding on its own, a second time, that a file the
 * service would refuse is fine to hand over.
 *
 * The cookie jar is the pattern `hybrid-credential-sync.integration.test.ts` uses: the
 * routes read the session through `next/headers`, which exists only inside a request.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let exportService: typeof import("../src/lib/data-transfer/export-service");
let parties: typeof import("../src/lib/parties-service");

const biz = { id: "", locationId: "" };

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

/** A membership row, seeded raw: these cases are about permissions, not about creation. */
async function seedMember(fields: { name: string; role: string; email?: string }): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, full_name, email, role, pin_hash)
     VALUES ($1, $2, $3, $4, '$2b$10$notarealhashnotarealhashnotarealhashno') RETURNING id`,
    [biz.id, fields.name, fields.email ?? null, fields.role],
  );
  return user.rows[0].id;
}

async function signInAs(userId: string, role: string, fullName: string) {
  const { signSession, SESSION_COOKIE } = await import("../src/lib/auth");
  const employee = await import("../src/lib/employee-service");
  const business = await db.query<{ slug: string }>("SELECT slug FROM businesses WHERE id = $1", [biz.id]);
  const { session } = await employee.createSession(userId, biz.id, { deviceLabel: "export-suite" });
  jar.set(
    SESSION_COOKIE,
    await signSession({
      sub: userId,
      role: role as never,
      businessId: biz.id,
      businessSlug: business.rows[0].slug,
      locationId: null,
      fullName,
      employeeSessionId: session.id,
    }),
  );
}

function jobRequest(id: string) {
  return [new NextRequest(`http://localhost/api/data/exports/${id}`), { params: Promise.resolve({ id }) }] as const;
}

function listRequest() {
  return new NextRequest("http://localhost/api/data/exports");
}

beforeAll(async () => {
  databaseName = `pos_exportaudience_${randomUUID().replaceAll("-", "")}`;
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
  exportService = await import("../src/lib/data-transfer/export-service");
  parties = await import("../src/lib/parties-service");

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

beforeEach(async () => {
  jar.clear();
  await db.query("DELETE FROM data_export_jobs");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM user_locations");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Export Co', $1, 'food_service') RETURNING id",
    [`exportco-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  await parties.createParty(biz.id, {
    role: "Customer",
    roles: ["Customer"],
    personType: "Real",
    displayName: "مشتری خروجی",
    addressInfo: { street: "خیابان مشتری" },
  });
});

describe("downloading a stored export again (issue #947)", () => {
  async function produceFile(audience: { personnel: boolean; financial: boolean }) {
    return dbLib.withTenant(biz.id, () =>
      exportService.createExportJob({
        businessId: biz.id,
        locationId: null,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: "صادرکنندهٔ اصلی",
        partyAudience: audience,
      }),
    );
  }

  it("serves the bytes to a reader who still holds what the file was produced under", async () => {
    const { job, body } = await produceFile({ personnel: true, financial: true });
    // The owner preset: personnel + ledger + bulk keys. This is the ordinary case — the
    // change must not break re-download for the people it was always for.
    await signInAs(await seedMember({ name: "مالک", role: "owner" }), "owner", "مالک");

    const route = await import("../src/app/api/data/exports/[id]/route");
    const response = await route.GET(...jobRequest(job.id));
    expect(response.status).toBe(200);
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.toString("utf8")).toBe(body.toString("utf8"));
  });

  it("refuses the same bytes to a manager whose key set no longer covers them", async () => {
    /*
     * The revocation path end to end. The manager preset holds `data.export` and
     * `crm.export` — so `entityAccess` is satisfied and the *only* thing that can stop
     * this download is the recorded audience. That is exactly the case the first pass
     * handed the file to.
     */
    const { job } = await produceFile({ personnel: true, financial: true });
    await signInAs(await seedMember({ name: "مدیر", role: "manager" }), "manager", "مدیر");

    const route = await import("../src/app/api/data/exports/[id]/route");
    const response = await route.GET(...jobRequest(job.id));
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: string; requires?: string[]; reason?: string };
    expect(payload.error).toBe("export_requires_regeneration");
    expect(payload.reason).toBe("audience_revoked");
    // The body names the capability, so the screen can say which key an owner would grant
    // rather than «forbidden».
    expect(payload.requires).toEqual(expect.arrayContaining(["team.view"]));
  });

  it("tells the history which rows this member may still download", async () => {
    const { job } = await produceFile({ personnel: true, financial: true });
    await signInAs(await seedMember({ name: "مدیر", role: "manager" }), "manager", "مدیر");

    const list = await import("../src/app/api/data/exports/route");
    const response = await list.GET(listRequest());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      jobs: { id: string; download: { allowed: boolean; reason?: string } }[];
    };
    const row = payload.jobs.find((entry) => entry.id === job.id);
    expect(row).toBeDefined();
    expect(row!.download.allowed).toBe(false);
    expect(row!.download.reason).toBe("audience_revoked");

    // And the owner sees the same row as downloadable — one rule, two readers.
    await signInAs(await seedMember({ name: "مالک", role: "owner" }), "owner", "مالک");
    const ownerView = (await (await list.GET(listRequest())).json()) as {
      jobs: { id: string; download: { allowed: boolean } }[];
    };
    expect(ownerView.jobs.find((entry) => entry.id === job.id)!.download.allowed).toBe(true);
  });

  it("still answers 410 for a file whose bytes were pruned, not 403", async () => {
    // Two different facts with two different sentences: «the file is gone» and «you may
    // not have it» must not be collapsed, or an operator would chase a permission they
    // already hold.
    const { job } = await produceFile({ personnel: false, financial: false });
    await db.query("UPDATE data_export_jobs SET expires_at = now() - interval '1 day'");
    await exportService.pruneExpiredExports();
    await signInAs(await seedMember({ name: "مالک", role: "owner" }), "owner", "مالک");

    const route = await import("../src/app/api/data/exports/[id]/route");
    const response = await route.GET(...jobRequest(job.id));
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toBe("content_expired");
  });

  it("refuses a suspended member before the file's provenance is even consulted", async () => {
    /*
     * A suspended membership does not reach the audience question: `dataOwner` resolves
     * the membership live through `requirePermission`, which answers 401 for a member who
     * is no longer active. That ordering is the right one — a file *everyone* could read
     * is still not readable by somebody who has been switched off — and it is asserted
     * here so a future change that widened the guard would be a visible failure rather
     * than a quiet one.
     */
    const { job } = await produceFile({ personnel: false, financial: false });
    const userId = await seedMember({ name: "تعلیق‌شده", role: "owner" });
    await db.query("UPDATE users SET is_active = false WHERE id = $1", [userId]);
    await signInAs(userId, "owner", "تعلیق‌شده");

    const route = await import("../src/app/api/data/exports/[id]/route");
    const response = await route.GET(...jobRequest(job.id));
    expect(response.status).toBe(401);
  });
});
