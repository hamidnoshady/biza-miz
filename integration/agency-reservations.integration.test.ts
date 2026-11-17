/**
 * #1128: planned member/task reservations, separate from actual time and accounting.
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
let provisioning: typeof import("../src/lib/business-provisioning");

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
  databaseName = `agency_reservation_${randomUUID().replaceAll("-", "")}`;

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
  provisioning = await import("../src/lib/business-provisioning");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

/* ------------------------------------------------------------------ fixtures */

let seq = 0;

interface Agency {
  businessId: string;
  locationId: string;
  clientId: string;
  projectId: string;
  actor: { userId: string; name: string };
}

async function agency(label = ""): Promise<Agency> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس بازپرداخت ${seq} ${label}`,
    ownerName: "حسابدار",
    // A real member, not a placeholder: `domain_events.created_by` and
    // `orders.opened_by` are foreign keys, so a posted document is attributed.
    email: `agency-recharge-${seq}-${randomUUID().slice(0, 6)}@example.test`,
    password: "correct-horse",
    subdomain: `agrech${seq}${randomUUID().slice(0, 4)}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  const actor = { userId: result.userId, name: "حسابدار" };
  const clientId = (
    await db.query(
      `INSERT INTO parties (business_id, name) VALUES ($1,'کارفرما') RETURNING id`,
      [result.businessId],
    )
  ).rows[0].id;
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id) VALUES ($1,'پروژهٔ کمپین',$2,$3) RETURNING id`,
      [result.businessId, actor.userId, actor.userId],
    )
  ).rows[0].id;
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    clientId,
    projectId,
    actor,
  };
}

let reservations: typeof import("../src/lib/agency-reservation-service");
beforeAll(async () => {
  reservations = await import("../src/lib/agency-reservation-service");
});
const owner = (a: Agency) => ({
  businessId: a.businessId,
  actorUserId: a.actor.userId,
  actorName: a.actor.name,
});
async function task(a: Agency, projectId = a.projectId) {
  return (
    await db.query(
      `INSERT INTO ai_project_tasks(project_id,title,created_by) VALUES($1,'تولید',$2) RETURNING id`,
      [projectId, a.actor.userId],
    )
  ).rows[0].id as string;
}
async function worker(a: Agency, role = "contributor") {
  const id = (
    await db.query(
      `INSERT INTO users(business_id,role,full_name,email,password_hash) VALUES($1,'manager','منبع',$2,'x') RETURNING id`,
      [a.businessId, randomUUID() + "@example.test"],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO workspace_members(project_id,user_id,role,added_by) VALUES($1,$2,$3,'test')`,
    [a.projectId, id, role],
  );
  return id;
}
const input = (
  taskId: string,
  workerId: string,
  extra: Record<string, unknown> = {},
) => ({
  taskId,
  workerId,
  startAt: "2026-11-01T09:00:00Z",
  endAt: "2026-11-01T10:00:00Z",
  note: "زمان برنامه‌ریزی‌شده",
  status: "reserved",
  supersedesId: null,
  requestId: randomUUID(),
  ...extra,
});
const window = { from: "2026-11-01", to: "2026-11-30", offset: 0 };
describe("planned agency resource reservations", () => {
  it("preserves retries and planned facts without writing actual time or accounting events", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a);
    const data = input(t, w);
    const r = await reservations.createReservation(owner(a), a.projectId, data);
    expect(
      await reservations.createReservation(owner(a), a.projectId, {
        ...data,
        startAt: "2026-11-01T12:30:00+03:30",
        endAt: "2026-11-01T13:30:00+03:30",
      }),
    ).toEqual(r);
    await expect(
      reservations.createReservation(owner(a), a.projectId, {
        ...data,
        note: "changed",
      }),
    ).rejects.toThrow("reservation_conflict");
    const list = await reservations.listReservations(
      owner(a),
      a.projectId,
      window,
    );
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({
      workerId: w,
      createdBy: a.actor.userId,
      workerName: "منبع",
      taskTitle: "تولید",
      status: "reserved",
    });
    expect(list.rows[0].startAt).toBe("2026-11-01T09:00:00.000Z");
    for (const table of ["agency_task_time", "domain_events"])
      expect(
        (
          await db.query(
            `SELECT count(*)::int n FROM ${table} WHERE business_id=$1`,
            [a.businessId],
          )
        ).rows[0].n,
      ).toBe(0);
  });
  it("reschedules and cancels without deleting history and refuses stale/changed-scope branches", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a);
    const r = await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w),
    );
    const moved = await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w, {
        supersedesId: r.id,
        startAt: "2026-11-01T12:00Z",
        endAt: "2026-11-01T13:00Z",
      }),
    );
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, { supersedesId: r.id }),
      ),
    ).rejects.toThrow("reservation_conflict");
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, { supersedesId: moved.id, status: "cancelled" }),
      ),
    ).rejects.toThrow("reservation_conflict");
    await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w, {
        supersedesId: moved.id,
        status: "cancelled",
        startAt: "2026-11-01T12:00Z",
        endAt: "2026-11-01T13:00Z",
        note: "لغو با دلیل",
      }),
    );
    const rows = (
      await reservations.listReservations(owner(a), a.projectId, window)
    ).rows;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => !r.superseded).map((r) => r.status)).toEqual([
      "cancelled",
    ]);
    await expect(
      db.query(
        `UPDATE agency_resource_reservations SET note='rewrite' WHERE id=$1`,
        [r.id],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(`DELETE FROM agency_resource_reservations WHERE id=$1`, [r.id]),
    ).rejects.toThrow("immutable");
    await expect(
      reservations.createReservation(owner(a), a.projectId, input(t, w)),
    ).resolves.toHaveProperty("id");
  });
  it("serializes concurrent cross-project overlap and discloses no other-project metadata", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a);
    const p = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id) VALUES($1,'پروژهٔ دیگر',$2::text,$2::uuid) RETURNING id`,
        [a.businessId, a.actor.userId],
      )
    ).rows[0].id;
    const t2 = await task(a, p);
    await db.query(
      `INSERT INTO workspace_members(project_id,user_id,role,added_by) VALUES($1,$2,'contributor','test')`,
      [p, w],
    );
    const results = await Promise.allSettled([
      reservations.createReservation(owner(a), a.projectId, input(t, w)),
      reservations.createReservation(owner(a), p, input(t2, w)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { message: "reservation_conflict" },
    });
    expect(
      (await reservations.listReservations(owner(a), a.projectId, window)).rows
        .length +
        (await reservations.listReservations(owner(a), p, window)).rows.length,
    ).toBe(1);
  });
  it("allows half-open adjacency but refuses cross-midnight overlaps for the same person", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a);
    await reservations.createReservation(owner(a), a.projectId, input(t, w));
    await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w, { startAt: "2026-11-01T10:00Z", endAt: "2026-11-01T11:00Z" }),
    );
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, {
          startAt: "2026-11-01T09:30Z",
          endAt: "2026-11-01T10:30Z",
        }),
      ),
    ).rejects.toThrow("reservation_conflict");
    await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w, { startAt: "2026-11-01T23:00Z", endAt: "2026-11-02T01:00Z" }),
    );
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, {
          startAt: "2026-11-02T00:00Z",
          endAt: "2026-11-02T02:00Z",
        }),
      ),
    ).rejects.toThrow("reservation_conflict");
    const other = await worker(a);
    await expect(
      reservations.createReservation(owner(a), a.projectId, input(t, other)),
    ).resolves.toHaveProperty("id");
  });
  it("refuses viewer/inactive/foreign staff and foreign tasks, while cancellation releases offboarded staff", async () => {
    const a = await agency(),
      b = await agency(),
      t = await task(a),
      foreign = await task(b),
      w = await worker(a),
      viewer = await worker(a, "viewer");
    for (const data of [
      input(t, viewer),
      input(t, b.actor.userId),
      input(foreign, w),
    ])
      await expect(
        reservations.createReservation(owner(a), a.projectId, data),
      ).rejects.toThrow("reservation_conflict");
    const r = await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w),
    );
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`, [w]);
    await db.query(
      `DELETE FROM workspace_members WHERE project_id=$1 AND user_id=$2`,
      [a.projectId, w],
    );
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, {
          startAt: "2026-11-02T09:00Z",
          endAt: "2026-11-02T10:00Z",
        }),
      ),
    ).rejects.toThrow("reservation_conflict");
    await expect(
      reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, {
          supersedesId: r.id,
          status: "cancelled",
          note: "پایان همکاری",
        }),
      ),
    ).resolves.toHaveProperty("id");
  });
  it("requires project management independently of platform authority and separates tenants/projects", async () => {
    const a = await agency(),
      b = await agency(),
      t = await task(a),
      w = await worker(a, "editor");
    await expect(
      reservations.createReservation(
        { ...owner(a), actorUserId: w },
        a.projectId,
        input(t, w),
      ),
    ).rejects.toThrow("insufficient_project_role");
    await expect(
      reservations.listReservations(owner(b), a.projectId, window),
    ).rejects.toThrow("project_not_found");
    const nonmember = await worker(a);
    await db.query(
      `DELETE FROM workspace_members WHERE project_id=$1 AND user_id=$2`,
      [a.projectId, nonmember],
    );
    await expect(
      reservations.listReservations(
        { ...owner(a), actorUserId: nonmember },
        a.projectId,
        window,
      ),
    ).rejects.toThrow("project_not_found");
    await reservations.createReservation(owner(a), a.projectId, input(t, w));
    const { deleteWorkspaceTask } = await import("../src/lib/workspace");
    await expect(deleteWorkspaceTask(a.businessId, t)).rejects.toThrow(
      "task_has_reservation_history",
    );
    await expect(
      db.query(`UPDATE ai_project_tasks SET project_id=$2 WHERE id=$1`, [
        t,
        b.projectId,
      ]),
    ).rejects.toThrow();
  });
  it("hides another client's reservation metadata while still refusing a busy shared worker", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a),
      manager = await worker(a, "manager");
    const otherParty = (
      await db.query(
        `INSERT INTO parties(business_id,name) VALUES($1,'مشتری محرمانه') RETURNING id`,
        [a.businessId],
      )
    ).rows[0].id;
    const p = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id,party_id) VALUES($1,'برنامه محرمانه',$2::text,$2::uuid,$3) RETURNING id`,
        [a.businessId, manager, otherParty],
      )
    ).rows[0].id;
    const t2 = await task(a, p);
    await db.query(
      `INSERT INTO workspace_members(project_id,user_id,role,added_by) VALUES($1,$2,'contributor','test')`,
      [p, w],
    );
    await reservations.createReservation(
      { ...owner(a), actorUserId: manager, actorName: "مدیر دیگر" },
      p,
      input(t2, w, { note: "اطلاعات محرمانه" }),
    );
    await expect(
      reservations.listReservations(owner(a), p, window),
    ).rejects.toThrow("project_not_found");
    expect(
      (await reservations.listReservations(owner(a), a.projectId, window)).rows,
    ).toEqual([]);
    await expect(
      reservations.createReservation(owner(a), a.projectId, input(t, w)),
    ).rejects.toMatchObject({
      code: "reservation_conflict",
      message: "reservation_conflict",
    });
  });
  it("allows a different authorized manager to retire a reservation without changing the original author", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a),
      manager = await worker(a, "manager");
    const r = await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w),
    );
    await reservations.createReservation(
      { ...owner(a), actorUserId: manager, actorName: "مدیر دیگر" },
      a.projectId,
      input(t, w, {
        status: "cancelled",
        supersedesId: r.id,
        note: "لغو توسط مدیر",
      }),
    );
    const rows = (
      await reservations.listReservations(owner(a), a.projectId, window)
    ).rows;
    expect(rows.find((row) => row.id === r.id)?.createdBy).toBe(a.actor.userId);
    expect(rows.find((row) => !row.superseded)).toMatchObject({
      createdBy: manager,
      createdByName: "مدیر دیگر",
      status: "cancelled",
      workerId: w,
    });
  });
  it("keeps one correction branch during concurrent manager edits", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a),
      r = await reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w),
      );
    const results = await Promise.allSettled(
      [12, 14].map((hour) =>
        reservations.createReservation(
          owner(a),
          a.projectId,
          input(t, w, {
            supersedesId: r.id,
            startAt: `2026-11-01T${hour}:00Z`,
            endAt: `2026-11-01T${hour + 1}:00Z`,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("uses the business timezone for bounded day filtering and supports history beyond 100 rows", async () => {
    const a = await agency(),
      t = await task(a),
      w = await worker(a);
    await db.query(
      `UPDATE locations SET timezone='Europe/Berlin' WHERE business_id=$1`,
      [a.businessId],
    );
    await reservations.createReservation(
      owner(a),
      a.projectId,
      input(t, w, { startAt: "2026-10-31T23:30Z", endAt: "2026-11-01T00:00Z" }),
    );
    expect(
      (
        await reservations.listReservations(owner(a), a.projectId, {
          from: "2026-11-01",
          to: "2026-11-01",
          offset: 0,
        })
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await reservations.listReservations(owner(a), a.projectId, {
          from: "2026-10-31",
          to: "2026-10-31",
          offset: 0,
        })
      ).rows,
    ).toHaveLength(0);
    for (let i = 0; i < 105; i++) {
      const start = new Date(Date.UTC(2026, 10, 2, 0, i * 2));
      const end = new Date(start.getTime() + 60000);
      await reservations.createReservation(
        owner(a),
        a.projectId,
        input(t, w, { startAt: start.toISOString(), endAt: end.toISOString() }),
      );
    }
    const first = await reservations.listReservations(
      owner(a),
      a.projectId,
      window,
    );
    expect(first.rows).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    expect(first.timeZone).toBe("Europe/Berlin");
    const second = await reservations.listReservations(owner(a), a.projectId, {
      ...window,
      offset: 100,
    });
    expect(second.rows).toHaveLength(6);
    expect(second.nextOffset).toBeNull();
  });
  it("refuses non-agency source calls and enforces tenant RLS with a nonbypass role", async () => {
    const a = await agency(),
      b = await agency(),
      t = await task(a),
      w = await worker(a);
    await reservations.createReservation(owner(a), a.projectId, input(t, w));
    const role = "reservation_rls_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS`);
    try {
      await db.query(
        `GRANT SELECT ON agency_resource_reservations TO "${role}"`,
      );
      await db.query(`SET ROLE "${role}"`);
      await db.query(
        `SELECT set_config('app.business_id',$1,false),set_config('app.rls_bypass','',false)`,
        [b.businessId],
      );
      expect(
        (await db.query(`SELECT id FROM agency_resource_reservations`)).rows,
      ).toEqual([]);
      await db.query(`SELECT set_config('app.business_id',$1,false)`, [
        a.businessId,
      ]);
      expect(
        (await db.query(`SELECT id FROM agency_resource_reservations`)).rows,
      ).toHaveLength(1);
    } finally {
      await db.query(`RESET ROLE`);
      await db.query(`SELECT set_config('app.business_id','',false)`);
      await db.query(
        `REVOKE ALL ON agency_resource_reservations FROM "${role}"`,
      );
      await db.query(`DROP ROLE "${role}"`);
    }
    await db.query(
      `UPDATE businesses SET industry='food_service' WHERE id=$1`,
      [b.businessId],
    );
    await expect(
      reservations.listReservations(owner(b), b.projectId, window),
    ).rejects.toThrow("industry_mismatch");
  });
});
