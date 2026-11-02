/**
 * Phase F, Part 3 — project tasks + their effect on the live prompt context,
 * against a real database.
 *
 * `tenant-isolation.integration.test.ts` proves ai_project_tasks carries RLS
 * like every other tenant table. This file proves the behaviour the feature
 * exists for:
 *
 *   - a task is created against a project (open, sourced) and read back;
 *   - the title-length and open-count bounds are enforced server-side;
 *   - a task is completed (stamps completed_at) and reopened;
 *   - a task is deleted;
 *   - the round-trip that matters: an OPEN task shows up in the project's prompt
 *     context, and once completed it DROPS OUT of that context.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { PROJECT_TASK_CHAR_LIMIT, PROJECT_TASK_MAX_OPEN } from "../src/lib/ai-projects-shared";
import { workspaceAccessFlags } from "../src/lib/workspace-shared";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let projects: typeof import("../src/lib/ai-projects");
let workspace: typeof import("../src/lib/workspace");

const alpha = { businessId: "", userId: "", projectId: "" };

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
  databaseName = `pos_ai_projtask_${randomUUID().replaceAll("-", "")}`;

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
  projects = await import("../src/lib/ai-projects");
  workspace = await import("../src/lib/workspace");

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

async function seedBusiness(name: string, slug: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${slug}@example.test`],
  );
  return { businessId, userId: user.rows[0].id };
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`));

  const project = await dbLib.withTenant(alpha.businessId, () =>
    projects.createProject(
      { businessId: alpha.businessId, actorUserId: alpha.userId },
      { name: "کمپین بهار", instructions: "لحن دوستانه داشته باش" },
    ),
  );
  alpha.projectId = project.id;
});

function owner() {
  return { businessId: alpha.businessId, actorUserId: alpha.userId, projectId: alpha.projectId };
}

/**
 * Issue #907 F01 — task state changes no longer live in `ai-projects.ts`.
 * `setTaskStatus`/`deleteTask` proved the parent business and nothing else, so
 * the legacy assistant route could complete or delete a task its caller had no
 * project role on and could skip the dependency rule. The one command is now
 * `workspace.updateWorkspaceTask` (dependency rule + completion stamp) and
 * `workspace.deleteWorkspaceTask`; the following tests exercise those, and
 * `workspace.integration.test.ts` proves the capability half.
 */
function workspaceOwner() {
  return {
    businessId: alpha.businessId,
    actorUserId: alpha.userId,
    access: workspaceAccessFlags(new Set(["workspace.view", "workspace.manage"])),
  };
}

function setDone(taskId: string, done: boolean) {
  return workspace.updateWorkspaceTask(workspaceOwner(), taskId, { status: done ? "done" : "open" });
}

describe("creating and reading tasks", () => {
  it("stores an open task and reads it back", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "تماس با تأمین‌کننده" }),
    );
    expect(created.status).toBe("open");
    expect(created.source).toBe("user");
    expect(created.completedAt).toBeNull();
    expect(created.title).toBe("تماس با تأمین‌کننده");

    const list = await dbLib.withTenant(alpha.businessId, () => projects.listTasks(owner()));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("records an AI-sourced task with its provenance", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "رزرو عکاس", source: "ai" }),
    );
    expect(created.source).toBe("ai");
  });

  it("orders open tasks before completed ones", async () => {
    const first = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "کار یک" }),
    );
    await dbLib.withTenant(alpha.businessId, () => projects.addTask(owner(), { title: "کار دو" }));
    // Complete the first (older) task — it should sink below the open one.
    await dbLib.withTenant(alpha.businessId, () => setDone(first.id, true));

    const list = await dbLib.withTenant(alpha.businessId, () => projects.listTasks(owner()));
    expect(list.map((t) => t.status)).toEqual(["open", "done"]);
    expect(list[0].title).toBe("کار دو");
  });
});

describe("bounds", () => {
  it("refuses an over-length task title", async () => {
    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        projects.addTask(owner(), { title: "x".repeat(PROJECT_TASK_CHAR_LIMIT + 1) }),
      ),
    ).rejects.toThrow(/character limit/);
  });

  it("refuses an empty task title", async () => {
    await expect(
      dbLib.withTenant(alpha.businessId, () => projects.addTask(owner(), { title: "   " })),
    ).rejects.toThrow(/required/);
  });

  it("counts only OPEN tasks against the cap, so completing one frees a slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < PROJECT_TASK_MAX_OPEN; i++) {
      const t = await dbLib.withTenant(alpha.businessId, () =>
        projects.addTask(owner(), { title: `task ${i}` }),
      );
      ids.push(t.id);
    }
    // Full: one more open task is refused.
    await expect(
      dbLib.withTenant(alpha.businessId, () => projects.addTask(owner(), { title: "one too many" })),
    ).rejects.toThrow(/too many open/);

    // Completing one drops the open count below the cap; a new task fits again.
    await dbLib.withTenant(alpha.businessId, () => setDone(ids[0], true));
    const added = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "now there is room" }),
    );
    expect(added.status).toBe("open");
  });
});

describe("completing, reopening and deleting", () => {
  it("stamps completed_at when done and clears it when reopened", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "کار موقت" }),
    );

    const done = await dbLib.withTenant(alpha.businessId, () => setDone(created.id, true));
    expect(done?.status).toBe("done");
    expect(done?.completedAt).not.toBeNull();

    const reopened = await dbLib.withTenant(alpha.businessId, () => setDone(created.id, false));
    expect(reopened?.status).toBe("open");
    expect(reopened?.completedAt).toBeNull();
  });

  it("returns null when toggling a task owned by another tenant", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "کار آلفا" }),
    );
    const other = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
    const result = await dbLib.withTenant(other.businessId, () =>
      workspace.updateWorkspaceTask(
        {
          businessId: other.businessId,
          actorUserId: other.userId,
          access: workspaceAccessFlags(new Set(["workspace.view", "workspace.manage"])),
        },
        created.id,
        { status: "done" },
      ),
    );
    expect(result).toBeNull();
  });

  it("deletes a task", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "کار حذف‌شدنی" }),
    );
    const ok = await dbLib.withTenant(alpha.businessId, () =>
      workspace.deleteWorkspaceTask(alpha.businessId, created.id),
    );
    expect(ok).toBe(true);
    const list = await dbLib.withTenant(alpha.businessId, () => projects.listTasks(owner()));
    expect(list).toHaveLength(0);
  });
});

describe("prompt context round-trip (an open task shapes the turn, a done one does not)", () => {
  it("includes an open task in the prompt context and drops it once completed", async () => {
    const task = await dbLib.withTenant(alpha.businessId, () =>
      projects.addTask(owner(), { title: "پیش‌نویس تخفیف نوروز" }),
    );

    const ctxOpen = await dbLib.withTenant(alpha.businessId, () =>
      projects.getProjectPromptContext(owner()),
    );
    expect(ctxOpen).not.toBeNull();
    if (!ctxOpen) return;
    expect(ctxOpen.openTasks.map((t) => t.id)).toContain(task.id);
    const renderedOpen = projects.buildProjectPromptContext(ctxOpen);
    expect(renderedOpen).toContain("کارهای باز پروژه");
    expect(renderedOpen).toContain("پیش‌نویس تخفیف نوروز");

    // Complete it — the context no longer surfaces it.
    await dbLib.withTenant(alpha.businessId, () => setDone(task.id, true));
    const ctxDone = await dbLib.withTenant(alpha.businessId, () =>
      projects.getProjectPromptContext(owner()),
    );
    expect(ctxDone).not.toBeNull();
    if (!ctxDone) return;
    expect(ctxDone.openTasks).toHaveLength(0);
    const renderedDone = projects.buildProjectPromptContext(ctxDone);
    expect(renderedDone).not.toContain("پیش‌نویس تخفیف نوروز");
  });
});
