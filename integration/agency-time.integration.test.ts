/**
 * #1128: actual time declarations over canonical tasks, without accounting posting.
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
  databaseName = `agency_time_${randomUUID().replaceAll("-", "")}`;

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

let time: typeof import("../src/lib/agency-time-service");
beforeAll(async () => {
  time = await import("../src/lib/agency-time-service");
});
const owner = (a: Agency) => ({
  businessId: a.businessId,
  actorUserId: a.actor.userId,
  actorName: a.actor.name,
});
async function task(a: Agency, projectId = a.projectId) {
  return (
    await db.query(
      `INSERT INTO ai_project_tasks(project_id,title,assignee_user_id,created_by) VALUES($1,'کار واقعی',$2::uuid,$2::text) RETURNING id`,
      [projectId, a.actor.userId],
    )
  ).rows[0].id as string;
}
const data = (taskId: string, extra: Record<string, unknown> = {}) => ({
  taskId,
  workDate: "2026-10-01",
  minutes: 60,
  note: "کار انجام‌شده",
  requestId: randomUUID(),
  supersedesId: null,
  ...extra,
});
describe("actual agency task time", () => {
  it("records self-declared time without ledger/events and retries the same request exactly once", async () => {
    const a = await agency(),
      t = await task(a),
      input = data(t);
    const r = await time.createAgencyTime(owner(a), a.projectId, input);
    expect(await time.createAgencyTime(owner(a), a.projectId, input)).toEqual(
      r,
    );
    await expect(
      time.createAgencyTime(owner(a), a.projectId, { ...input, minutes: 61 }),
    ).rejects.toThrow("time_conflict");
    const result = await time.listAgencyTime(owner(a), a.projectId);
    expect(result.rows).toHaveLength(1);
    expect(result.totalMinutes).toBe("60");
    expect(result.rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.rows[0]).toMatchObject({
      createdBy: a.actor.userId,
      taskTitle: "کار واقعی",
      note: input.note,
    });
    expect(
      (
        await db.query(
          `SELECT count(*)::int n FROM domain_events WHERE business_id=$1`,
          [a.businessId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("retains corrections and void history, without summing replaced versions", async () => {
    const a = await agency(),
      t = await task(a);
    const r = await time.createAgencyTime(owner(a), a.projectId, data(t));
    const corrected = await time.createAgencyTime(
      owner(a),
      a.projectId,
      data(t, { minutes: 30, supersedesId: r.id, note: "اصلاح برآورد" }),
    );
    expect(
      (await time.listAgencyTime(owner(a), a.projectId)).totalMinutes,
    ).toBe("30");
    await time.createAgencyTime(
      owner(a),
      a.projectId,
      data(t, {
        minutes: 0,
        supersedesId: corrected.id,
        note: "ثبت اشتباه بود",
      }),
    );
    const history = await time.listAgencyTime(owner(a), a.projectId);
    expect(history.rows).toHaveLength(3);
    expect(history.totalMinutes).toBeNull();
    await expect(
      db.query(`UPDATE agency_task_time SET minutes=5 WHERE id=$1`, [r.id]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(`DELETE FROM agency_task_time WHERE id=$1`, [r.id]),
    ).rejects.toThrow("immutable");
    await expect(
      time.createAgencyTime(
        owner(a),
        a.projectId,
        data(t, { supersedesId: r.id }),
      ),
    ).rejects.toThrow("time_conflict");
  });
  it("serializes a global per-worker daily capacity ceiling across projects", async () => {
    const a = await agency(),
      t = await task(a);
    const p = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id) VALUES($1,'دیگر',$2::text,$2::uuid) RETURNING id`,
        [a.businessId, a.actor.userId],
      )
    ).rows[0].id;
    const t2 = await task(a, p);
    const results = await Promise.allSettled([
      time.createAgencyTime(owner(a), a.projectId, data(t, { minutes: 1000 })),
      time.createAgencyTime(owner(a), p, data(t2, { minutes: 1000 })),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const x = await time.listAgencyTime(owner(a), a.projectId),
      y = await time.listAgencyTime(owner(a), p);
    expect(Number(x.totalMinutes ?? 0) + Number(y.totalMinutes ?? 0)).toBe(
      1000,
    );
  });
  it("allows one concurrent correction branch and rejects changed day/task lineage", async () => {
    const a = await agency(),
      t = await task(a);
    const r = await time.createAgencyTime(owner(a), a.projectId, data(t));
    await expect(
      time.createAgencyTime(
        owner(a),
        a.projectId,
        data(t, { workDate: "2026-10-02", supersedesId: r.id }),
      ),
    ).rejects.toThrow("time_conflict");
    const results = await Promise.allSettled(
      [30, 40].map((minutes) =>
        time.createAgencyTime(
          owner(a),
          a.projectId,
          data(t, { minutes, supersedesId: r.id }),
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("separates tenants and same-tenant projects and freezes logged task scope", async () => {
    const a = await agency(),
      b = await agency(),
      t = await task(a),
      t2 = await task(b);
    await expect(time.listAgencyTime(owner(b), a.projectId)).rejects.toThrow(
      "project_not_found",
    );
    await expect(
      time.createAgencyTime(owner(a), a.projectId, data(t2)),
    ).rejects.toThrow("task_not_found");
    const p = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id) VALUES($1,'دو',$2::text,$2::uuid) RETURNING id`,
        [a.businessId, a.actor.userId],
      )
    ).rows[0].id;
    await expect(time.createAgencyTime(owner(a), p, data(t))).rejects.toThrow(
      "task_not_found",
    );
    await time.createAgencyTime(owner(a), a.projectId, data(t));
    await expect(
      db.query(`UPDATE ai_project_tasks SET project_id=$2 WHERE id=$1`, [t, p]),
    ).rejects.toThrow("frozen");
    await expect(
      db.query(`DELETE FROM ai_project_tasks WHERE id=$1`, [t]),
    ).rejects.toThrow();
    const { deleteWorkspaceTask } = await import("../src/lib/workspace");
    await expect(deleteWorkspaceTask(a.businessId, t)).rejects.toThrow(
      "task_has_time_history",
    );
  });
  it("requires project contribution and assignment for new contributor logs, never impersonates another worker", async () => {
    const a = await agency(),
      t = await task(a);
    const u = (
      await db.query(
        `INSERT INTO users(business_id,role,full_name,email,password_hash) VALUES($1,'manager','همکار',$2,'x') RETURNING id`,
        [a.businessId, randomUUID() + "@example.test"],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO workspace_members(project_id,user_id,role,added_by) VALUES($1,$2,'viewer','test')`,
      [a.projectId, u],
    );
    const member = { ...owner(a), actorUserId: u };
    await expect(
      time.createAgencyTime(member, a.projectId, data(t)),
    ).rejects.toThrow("insufficient_project_role");
    await db.query(
      `UPDATE workspace_members SET role='contributor' WHERE project_id=$1 AND user_id=$2`,
      [a.projectId, u],
    );
    await expect(
      time.createAgencyTime(member, a.projectId, data(t)),
    ).rejects.toThrow("time_forbidden");
    await db.query(
      `UPDATE ai_project_tasks SET assignee_user_id=$2 WHERE id=$1`,
      [t, u],
    );
    const r = await time.createAgencyTime(
      member,
      a.projectId,
      data(t, { createdBy: a.actor.userId }),
    );
    expect(
      (await time.listAgencyTime(member, a.projectId)).rows[0].createdBy,
    ).toBe(u);
    await expect(
      time.createAgencyTime(
        owner(a),
        a.projectId,
        data(t, { supersedesId: r.id }),
      ),
    ).rejects.toThrow("time_conflict");
    await db.query(
      `UPDATE ai_project_tasks SET assignee_user_id=NULL WHERE id=$1`,
      [t],
    );
    await expect(
      time.createAgencyTime(
        member,
        a.projectId,
        data(t, { supersedesId: r.id, minutes: 30 }),
      ),
    ).resolves.toHaveProperty("id");
  });
  it("aggregates all effective entries beyond the history cap, not just the loaded page", async () => {
    const a = await agency(),
      t = await task(a);
    for (let n = 0; n < 105; n++)
      await time.createAgencyTime(
        owner(a),
        a.projectId,
        data(t, { minutes: 1 }),
      );
    const history = await time.listAgencyTime(owner(a), a.projectId);
    expect(history.rows).toHaveLength(100);
    expect(history.totalMinutes).toBe("105");
    await expect(
      time.createAgencyTime(
        owner(a),
        a.projectId,
        data(t, { workDate: "2099-01-01" }),
      ),
    ).rejects.toThrow("invalid_time");
  });
  it("refuses a non-agency industry at the source boundary", async () => {
    const a = await agency(),
      t = await task(a);
    await db.query(
      `UPDATE businesses SET industry='food_service' WHERE id=$1`,
      [a.businessId],
    );
    await expect(
      time.createAgencyTime(owner(a), a.projectId, data(t)),
    ).rejects.toThrow("industry_mismatch");
    await expect(time.listAgencyTime(owner(a), a.projectId)).rejects.toThrow(
      "industry_mismatch",
    );
  });
  it("enforces tenant RLS under a nonbypass role", async () => {
    const a = await agency(),
      b = await agency(),
      t = await task(a);
    await time.createAgencyTime(owner(a), a.projectId, data(t));
    const role = "time_rls_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT ON agency_task_time TO "${role}"`);
      await db.query(`SET ROLE "${role}"`);
      await db.query(
        `SELECT set_config('app.business_id',$1,false),set_config('app.rls_bypass','',false)`,
        [b.businessId],
      );
      expect((await db.query(`SELECT id FROM agency_task_time`)).rows).toEqual(
        [],
      );
      await db.query(`SELECT set_config('app.business_id',$1,false)`, [
        a.businessId,
      ]);
      expect(
        (await db.query(`SELECT id FROM agency_task_time`)).rows,
      ).toHaveLength(1);
    } finally {
      await db.query(`RESET ROLE`);
      await db.query(`SELECT set_config('app.business_id','',false)`);
      await db.query(`REVOKE ALL ON agency_task_time FROM "${role}"`);
      await db.query(`DROP ROLE "${role}"`);
    }
  });
});
