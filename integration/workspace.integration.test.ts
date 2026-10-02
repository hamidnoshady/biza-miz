/**
 * Phase G — «میز کار من», against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves every new table carries
 * RLS. This file proves the behaviour the module exists for, and above all the
 * promise the brief opens with: **existing project data survives**. So it
 * starts by creating a project through the OLD `ai-projects` service — the
 * pre-Phase-G write path, still live — and then reads it back through the new
 * workspace service, which is the exact journey an existing tenant's rows take.
 *
 * The rest covers the joins a unit test cannot: the two permission layers, the
 * approval gate propagating to its subject, document version chains, the
 * calendar's five sources unioned over one date range, the dependency guard,
 * and the report's spend figure coming from the ledger rather than from a
 * workspace counter.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { todayIsoDate } from "../src/lib/jalali";
import { workspaceAccessFlags, type WorkspaceAccessFlags } from "../src/lib/workspace-shared";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let workspace: typeof import("../src/lib/workspace");
let legacyProjects: typeof import("../src/lib/ai-projects");

const alpha = { businessId: "", ownerId: "", memberId: "", outsiderId: "", partyId: "" };
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
  databaseName = `pos_workspace_${randomUUID().replaceAll("-", "")}`;

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
  workspace = await import("../src/lib/workspace");
  legacyProjects = await import("../src/lib/ai-projects");

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
  return { businessId, ownerId: user.rows[0].id };
}

async function seedUser(businessId: string, name: string, slug: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
    [businessId, name, `${slug}-${randomUUID().slice(0, 8)}@example.test`],
  );
  return rows[0].id;
}

beforeEach(async () => {
  // Ledger rows written by the spend test hold accounts → businesses.
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const a = await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`);
  alpha.businessId = a.businessId;
  alpha.ownerId = a.ownerId;
  alpha.memberId = await seedUser(a.businessId, "عضو تیم", "member");
  alpha.outsiderId = await seedUser(a.businessId, "همکار بیرون پروژه", "outsider");

  const party = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'کارفرمای الف', 'customer') RETURNING id`,
    [a.businessId],
  );
  alpha.partyId = party.rows[0].id;

  const b = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
  beta.businessId = b.businessId;
  beta.ownerId = b.ownerId;
});

/** The business owner: every permission, so the `workspace.admin` override. */
const ADMIN = workspaceAccessFlags(new Set([
  "workspace.view", "workspace.manage", "workspace.contracts_manage",
  "workspace.approve", "workspace.admin", "ledger.view",
]));
/** A colleague with every workspace write but no override: membership decides. */
const MEMBER = workspaceAccessFlags(new Set([
  "workspace.view", "workspace.manage", "workspace.contracts_manage", "workspace.approve",
]));

function owner(userId = alpha.ownerId, access?: WorkspaceAccessFlags) {
  return {
    businessId: alpha.businessId,
    actorUserId: userId,
    actorName: "Owner",
    access: access ?? (userId === alpha.ownerId ? ADMIN : MEMBER),
  };
}

/** Run inside Alpha's tenant scope — everything the service does needs one. */
function inAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(alpha.businessId, fn);
}

async function makeProject(overrides: Record<string, unknown> = {}) {
  return inAlpha(() =>
    workspace.createWorkspaceProject(owner(), {
      name: "برج شمال",
      description: "اجرای اسکلت و نما",
      status: "active",
      priority: "high",
      startDate: "2026-01-05",
      endDate: "2026-09-30",
      partyId: alpha.partyId,
      budgetRial: 5_000_000_000,
      tags: ["ساختمانی", "تهران"],
      ...overrides,
    }),
  );
}

/* ===========================================================================
 * The migration promise: old data, new module
 * ======================================================================== */

describe("existing project data", () => {
  it("is readable through the workspace service after the migration", async () => {
    // Written the pre-Phase-G way, through the service that has always owned
    // `ai_projects`. This is the shape every existing tenant's rows are in.
    const legacy = await inAlpha(() =>
      legacyProjects.createProject(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId },
        { name: "کمپین بهار", instructions: "لحن دوستانه داشته باش" },
      ),
    );

    const seen = await inAlpha(() => workspace.getWorkspaceProject(alpha.businessId, legacy.id));
    expect(seen).not.toBeNull();
    expect(seen!.name).toBe("کمپین بهار");
    // 0167's defaults, applied to a row the old code wrote without them.
    expect(seen!.status).toBe("active");
    expect(seen!.priority).toBe("normal");
    expect(seen!.tags).toEqual([]);

    const list = await inAlpha(() =>
      workspace.listWorkspaceProjects(owner(), { status: "all" }),
    );
    expect(list.map((p) => p.id)).toContain(legacy.id);
  });

  it("keeps the old service working on a project the workspace created", async () => {
    const project = await makeProject();

    // The old note/memory/task paths must still write against a new project —
    // this is the "both APIs live at once" guarantee, not a one-way door.
    const note = await inAlpha(() =>
      legacyProjects.addNote(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId, projectId: project.id },
        { title: "صورت‌جلسهٔ کارگاه", content: "بتن‌ریزی طبقهٔ سوم" },
      ),
    );
    expect(note.title).toBe("صورت‌جلسهٔ کارگاه");

    const notes = await inAlpha(() =>
      legacyProjects.listNotes({
        businessId: alpha.businessId,
        actorUserId: alpha.ownerId,
        projectId: project.id,
      }),
    );
    expect(notes).toHaveLength(1);
  });

  it("gives every existing project an owner member row", async () => {
    const legacy = await inAlpha(() =>
      legacyProjects.createProject(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId },
        { name: "پروژهٔ قدیمی" },
      ),
    );
    // The old path knows nothing about workspace_members; the 0193 trigger
    // writes the owner row anyway, so the creator's project page AND their
    // «پروژه‌های من» list both admit the project — membership-only access.
    const role = await inAlpha(() =>
      workspace.resolveProjectRole(owner(alpha.ownerId, MEMBER), legacy.id),
    );
    expect(role).toBe("owner");
    const mine = await inAlpha(() =>
      workspace.listWorkspaceProjects(owner(alpha.ownerId, MEMBER), {
        memberUserId: alpha.ownerId,
        status: "all",
      }),
    );
    expect(mine.map((p) => p.id)).toContain(legacy.id);
  });
});

/* ===========================================================================
 * Tenancy
 * ======================================================================== */

describe("tenant isolation", () => {
  it("never returns another business's project, contract or task", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان اسکلت",
        contractType: "contractor",
        projectId: project.id,
        status: "active",
        endDate: "2026-04-01",
      }),
    );

    const seen = await dbLib.withTenant(beta.businessId, () =>
      workspace.getWorkspaceProject(beta.businessId, project.id),
    );
    expect(seen).toBeNull();

    const contracts = await dbLib.withTenant(beta.businessId, () =>
      workspace.listContracts(
        { businessId: beta.businessId, actorUserId: beta.ownerId, access: ADMIN },
        { status: "all" },
      ),
    );
    expect(contracts).toHaveLength(0);

    const tasks = await dbLib.withTenant(beta.businessId, () =>
      workspace.listWorkspaceTasks(
        { businessId: beta.businessId, actorUserId: beta.ownerId, access: ADMIN },
        { status: "all" },
      ),
    );
    expect(tasks).toHaveLength(0);
  });

  it("refuses to attach another business's party to a project", async () => {
    const betaParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'کارفرمای بتا', 'customer') RETURNING id`,
      [beta.businessId],
    );
    await expect(
      inAlpha(() =>
        workspace.createWorkspaceProject(owner(), {
          name: "نشتِ مستأجر",
          partyId: betaParty.rows[0].id,
        }),
      ),
    ).rejects.toThrow();
  });
});

/* ===========================================================================
 * The second permission layer
 * ======================================================================== */

describe("project capabilities", () => {
  it("admits the creator as owner and refuses a non-member", async () => {
    const project = await makeProject();

    await expect(
      inAlpha(() => workspace.requireProjectCapability(owner(), project.id, "administer")),
    ).resolves.toBe("owner");

    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId), project.id, "view"),
      ),
    ).rejects.toThrow();
  });

  it("gives a viewer read but not write, and an editor write", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "viewer"));

    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "view"),
      ),
    ).resolves.toBe("viewer");
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "edit"),
      ),
    ).rejects.toThrow();

    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "edit"),
      ),
    ).resolves.toBe("editor");
  });

  it("lets only the explicit workspace.admin override in without a member row", async () => {
    const project = await makeProject();
    // `workspace.manage` alone is NOT a pass to every project (#761)…
    await expect(
      inAlpha(() => workspace.requireProjectCapability(owner(alpha.outsiderId), project.id, "view")),
    ).rejects.toThrow(/project_not_found/);
    // …the explicit override is, as a manager…
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId, ADMIN), project.id, "manage"),
      ),
    ).resolves.toBe("manager");
    // …and the ledger reader's override is read-only.
    const reader = workspaceAccessFlags(new Set(["workspace.view", "ledger.view"]));
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId, reader), project.id, "view"),
      ),
    ).resolves.toBe("viewer");
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId, reader), project.id, "edit"),
      ),
    ).rejects.toThrow(/insufficient_project_role/);
  });

  it("refuses to remove the last owner", async () => {
    const project = await makeProject();
    await expect(
      inAlpha(() => workspace.removeMember(owner(), project.id, alpha.ownerId)),
    ).rejects.toThrow(/last_owner/);
  });
});

/* ===========================================================================
 * Templates and phases
 * ======================================================================== */

describe("templates", () => {
  it("seeds phases from a built-in template on create", async () => {
    const project = await makeProject({ templateKey: "construction" });
    const phases = await inAlpha(() => workspace.listPhases(project.id));
    expect(phases.length).toBeGreaterThan(2);
    expect(phases[0].displayOrder).toBeLessThan(phases[1].displayOrder);
  });

  it("lets a business override a built-in by key and archive its own", async () => {
    const saved = await inAlpha(() =>
      workspace.saveTemplate(owner(), {
        key: "construction",
        name: "ساخت‌وساز (نسخهٔ ما)",
        phases: [{ name: "پیش‌طراحی" }, { name: "اجرا" }],
        defaultTasks: ["اخذ پروانه"],
      }),
    );
    const construction = saved.filter((t) => t.key === "construction");
    expect(construction).toHaveLength(1);
    expect(construction[0].name).toBe("ساخت‌وساز (نسخهٔ ما)");

    const after = await inAlpha(() => workspace.archiveTemplate(alpha.businessId, "construction"));
    // Archiving the business row brings the built-in back rather than leaving
    // a hole — a built-in is code, shared by every tenant.
    expect(after.find((t) => t.key === "construction")?.name).not.toBe("ساخت‌وساز (نسخهٔ ما)");
  });
});

/* ===========================================================================
 * Tasks
 * ======================================================================== */

describe("tasks", () => {
  it("serves List, Kanban and Calendar from one query", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "سفارش میلگرد",
        assigneeUserId: alpha.memberId,
        dueDate: "2026-02-10",
        priority: "urgent",
      }),
    );
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "بازرسی جوش",
        status: "done",
      }),
    );

    const open = await inAlpha(() =>
      workspace.listWorkspaceTasks(owner(), { status: "open_only" }),
    );
    expect(open.map((t) => t.title)).toEqual(["سفارش میلگرد"]);

    const all = await inAlpha(() =>
      workspace.listWorkspaceTasks(owner(), { status: "all" }),
    );
    expect(all).toHaveLength(2);

    const mine = await inAlpha(() =>
      workspace.listWorkspaceTasks(owner(), {
        assigneeUserId: alpha.memberId,
        status: "all",
      }),
    );
    expect(mine.map((t) => t.title)).toEqual(["سفارش میلگرد"]);
    expect(mine[0].projectName).toBe("برج شمال");
  });

  it("carries a checklist and rolls it up onto the task", async () => {
    const project = await makeProject();
    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "تحویل موقت" }),
    );
    const items = await inAlpha(() => workspace.addChecklistItem(task.id, "تست عایق"));
    await inAlpha(() => workspace.addChecklistItem(task.id, "تست برق"));
    await inAlpha(() => workspace.setChecklistItem(task.id, items[0].id, true));

    const read = await inAlpha(() => workspace.getWorkspaceTask(alpha.businessId, task.id));
    expect(read!.checklistTotal).toBe(2);
    expect(read!.checklistDone).toBe(1);
  });

  it("refuses a dependency that would close a cycle", async () => {
    const project = await makeProject();
    const a = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "الف" }),
    );
    const b = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "ب" }),
    );
    await inAlpha(() => workspace.addDependency(alpha.businessId, b.id, a.id));
    await expect(
      inAlpha(() => workspace.addDependency(alpha.businessId, a.id, b.id)),
    ).rejects.toThrow();
  });
});

/* ===========================================================================
 * Contracts, documents and the approval gate
 * ======================================================================== */

describe("the approval gate", () => {
  it("moves a contract draft → pending → active as it is decided", async () => {
    const project = await makeProject();
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان نما",
        contractType: "subcontractor",
        projectId: project.id,
        partyId: alpha.partyId,
        valueRial: 900_000_000,
        startDate: "2026-02-01",
        endDate: "2026-08-01",
      }),
    );
    expect(contract.status).toBe("draft");

    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید پیمان نما",
        approverUserId: alpha.memberId,
        dueDate: "2026-01-25",
      }),
    );
    expect(approval.status).toBe("pending");
    // Requesting propagates: the contract list must not still say «پیش‌نویس».
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe(
      "pending_approval",
    );

    // The named approver decides — not the requester.
    const decided = await inAlpha(() =>
      workspace.decideApproval(owner(alpha.memberId), approval.id, "approved", "تأیید شد"),
    );
    expect(decided!.status).toBe("approved");
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe(
      "active",
    );

    // A decided approval cannot be decided twice.
    const again = await inAlpha(() =>
      workspace.decideApproval(owner(), approval.id, "rejected"),
    );
    expect(again).toBeNull();
  });

  it("resolves the subject's own title rather than storing a copy", async () => {
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), { title: "نام اول", contractType: "vendor" }),
    );
    await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        title: "تأیید",
      }),
    );
    await inAlpha(() => workspace.updateContract(owner(), contract.id, { title: "نام دوم" }));

    const [approval] = await inAlpha(() =>
      workspace.listApprovals(owner(), { status: "all" }),
    );
    expect(approval.subjectTitle).toBe("نام دوم");
  });
});

describe("documents", () => {
  it("chains versions and hides superseded ones from the default list", async () => {
    const project = await makeProject();
    const v1 = await inAlpha(() =>
      workspace.createDocument(owner(), {
        title: "نقشهٔ سازه",
        projectId: project.id,
        tags: ["نقشه"],
      }),
    );
    expect(v1.version).toBe(1);

    const v2 = await inAlpha(() =>
      workspace.createDocument(owner(), {
        title: "نقشهٔ سازه",
        projectId: project.id,
        supersedesId: v1.id,
      }),
    );
    expect(v2.version).toBe(2);

    const current = await inAlpha(() =>
      workspace.listDocuments(owner(), { projectId: project.id, currentOnly: true }),
    );
    expect(current.map((d) => d.id)).toEqual([v2.id]);

    // Newest revision first — a version history reads from the top. And the
    // chain is the same set whichever end you ask from.
    const chain = await inAlpha(() => workspace.listDocumentVersions(alpha.businessId, v2.id));
    expect(chain.map((d) => d.version)).toEqual([2, 1]);
    const fromRoot = await inAlpha(() => workspace.listDocumentVersions(alpha.businessId, v1.id));
    expect(fromRoot.map((d) => d.version)).toEqual([2, 1]);
  });
});

/* ===========================================================================
 * Calendar, dashboard and the accounting integration
 * ======================================================================== */

describe("dates crossing the driver boundary", () => {
  it("serves every date as YYYY-MM-DD, not as a stringified JS Date", async () => {
    // The bug this pins: node-postgres returns a `date` column as a JS Date,
    // and `String(d).slice(0, 10)` yields "Sun Mar 01" — ten characters of
    // `toString()`. It type-checks (it is a string), it survives every unit
    // test that does not look at the value, and it reaches the UI as a date no
    // picker can parse and no Jalali converter can read. Asserting the SHAPE
    // is the only thing that catches it.
    const iso = /^\d{4}-\d{2}-\d{2}$/;

    const project = await makeProject({ startDate: "2026-03-01", endDate: "2026-07-30" });
    expect(project.startDate).toMatch(iso);
    expect(project.endDate).toMatch(iso);
    expect(project.startDate).toBe("2026-03-01");
    expect(project.endDate).toBe("2026-07-30");

    // …and again on the read path, which is a different mapper.
    const fetched = await inAlpha(() =>
      workspace.getWorkspaceProject(alpha.businessId, project.id),
    );
    expect(fetched?.startDate).toBe("2026-03-01");
    const listed = await inAlpha(() => workspace.listWorkspaceProjects(owner(), {}));
    expect(listed.find((p) => p.id === project.id)?.endDate).toBe("2026-07-30");

    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "تاریخ‌دار",
        dueDate: "2026-04-05",
      }),
    );
    expect(task.dueDate).toBe("2026-04-05");
    const tasks = await inAlpha(() =>
      workspace.listWorkspaceTasks(owner(), { projectId: project.id }),
    );
    expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe("2026-04-05");

    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان تاریخ‌دار",
        contractType: "vendor",
        projectId: project.id,
        startDate: "2026-03-05",
        endDate: "2026-10-15",
      }),
    );
    expect(contract.startDate).toBe("2026-03-05");
    expect(contract.endDate).toBe("2026-10-15");

    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید",
        dueDate: "2026-03-25",
      }),
    );
    expect(approval.dueDate).toBe("2026-03-25");

    // The calendar is the one place dates are compared as strings, so a
    // non-ISO value there silently breaks ordering and range filtering.
    const entries = await inAlpha(() =>
      workspace.listCalendar(owner(), { from: "2026-01-01", to: "2026-12-31" }),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.date).toMatch(iso);
    // Sorted, which only holds if the strings really are ISO.
    const dates = entries.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("the unified calendar", () => {
  it("unions events with the four derived date sources", async () => {
    const project = await makeProject({ endDate: "2026-03-20" });
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "تحویل نقشه",
        dueDate: "2026-03-10",
      }),
    );
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان تأسیسات",
        contractType: "supplier",
        projectId: project.id,
        status: "active",
        endDate: "2026-03-15",
      }),
    );
    await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید تأسیسات",
        dueDate: "2026-03-05",
      }),
    );
    await inAlpha(() =>
      workspace.createEvent(owner(), {
        title: "جلسهٔ کارگاهی",
        kind: "meeting",
        eventDate: "2026-03-12",
        projectId: project.id,
      }),
    );

    const entries = await inAlpha(() =>
      workspace.listCalendar(owner(), { from: "2026-03-01", to: "2026-03-31" }),
    );
    const sources = new Set(entries.map((e) => e.source));
    expect(sources).toContain("event");
    expect(sources).toContain("project_deadline");
    expect(sources).toContain("task_due");
    expect(sources).toContain("contract_expiry");
    expect(sources).toContain("approval_due");

    // A date outside the window is not in the answer.
    const narrow = await inAlpha(() =>
      workspace.listCalendar(owner(), { from: "2026-03-11", to: "2026-03-13" }),
    );
    expect(narrow.every((e) => e.date >= "2026-03-11" && e.date <= "2026-03-13")).toBe(true);
  });
});

describe("the dashboard and the report", () => {
  it("counts the four headline figures from the rows that own them", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "کار من",
        assigneeUserId: alpha.ownerId,
        // The business's day (Tehran), the same "today" the dashboard uses.
        dueDate: todayIsoDate(),
      }),
    );
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان", contractType: "consultant", projectId: project.id,
      }),
    );
    // A colleague on the project asks and names the owner, so it is in the
    // owner's «منتظر تصمیم من» count.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    await inAlpha(() =>
      workspace.requestApproval(owner(alpha.memberId), {
        subjectType: "contract",
        subjectId: contract.id,
        title: "تأیید",
        approverUserId: alpha.ownerId,
      }),
    );

    const dash = await inAlpha(() => workspace.getWorkspaceDashboard(owner()));
    expect(dash.activeProjects).toBe(1);
    expect(dash.tasksToday).toBeGreaterThanOrEqual(1);
    expect(dash.pendingApprovals).toBe(1);
    expect(dash.myTasks.length).toBeGreaterThanOrEqual(1);
    expect(dash.activity.length).toBeGreaterThan(0);
  });

  it("reads project spend from the ledger, not from a workspace counter", async () => {
    const project = await makeProject({ budgetRial: 1_000_000 });

    // A posted expense against this project, written the way Accounting does:
    // an entry carrying `project_id` and a debit line.
    const account = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '6001', 'هزینهٔ پروژه', 'expense') RETURNING id`,
      [alpha.businessId],
    );
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, project_id, created_by)
       VALUES ($1, CURRENT_DATE, 'خرید مصالح', $2, $3) RETURNING id`,
      [alpha.businessId, project.id, alpha.ownerId],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 250000, 0)`,
      [entry.rows[0].id, account.rows[0].id],
    );

    const [row] = await inAlpha(() => workspace.projectReport(owner()));
    expect(row.projectId).toBe(project.id);
    expect(row.spentRial).toBe(250_000);
    expect(row.budgetRial).toBe(1_000_000);

    // A project member who may not read the books sees the project, not the
    // ledger figure — null, never a misleading 0.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "viewer"));
    const [memberRow] = await inAlpha(() => workspace.projectReport(owner(alpha.memberId)));
    expect(memberRow.projectId).toBe(project.id);
    expect(memberRow.spentRial).toBeNull();

    // A colleague not on the project sees no row at all.
    expect(await inAlpha(() => workspace.projectReport(owner(alpha.outsiderId)))).toEqual([]);
  });
});

/* ===========================================================================
 * #761 — one access model, subject integrity, approvals
 * ======================================================================== */

describe("project visibility (#761)", () => {
  it("never lets a non-member enumerate a project or anything inside it", async () => {
    const project = await makeProject();
    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "مخفی", dueDate: "2026-03-10" }),
    );
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان مخفی", contractType: "vendor", projectId: project.id, endDate: "2026-03-12",
      }),
    );
    await inAlpha(() =>
      workspace.createDocument(owner(), { title: "سند مخفی", projectId: project.id }),
    );
    await inAlpha(() => workspace.addComment(owner(), "task", task.id, "یادداشت"));

    const outsider = owner(alpha.outsiderId);
    expect(await inAlpha(() => workspace.listWorkspaceProjects(outsider, { status: "all" }))).toEqual([]);
    expect(await inAlpha(() => workspace.listWorkspaceTasks(outsider, { status: "all" }))).toEqual([]);
    expect(await inAlpha(() => workspace.listContracts(outsider, { status: "all" }))).toEqual([]);
    expect(await inAlpha(() => workspace.listDocuments(outsider, {}))).toEqual([]);
    expect(await inAlpha(() => workspace.listActivity(outsider, {}))).toEqual([]);
    expect(
      await inAlpha(() => workspace.listCalendar(outsider, { from: "2026-01-01", to: "2026-12-31" })),
    ).toEqual([]);
    const dash = await inAlpha(() => workspace.getWorkspaceDashboard(outsider));
    expect(dash.activeProjects).toBe(0);
    // A subject by id is "not found" — existence is not leaked either.
    await expect(
      inAlpha(() => workspace.resolveWorkspaceSubject(outsider, "task", task.id, "view")),
    ).rejects.toThrow(/subject_not_found/);

    // Added as a viewer, the same member sees it — and still cannot write.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.outsiderId, "viewer"));
    expect((await inAlpha(() => workspace.listWorkspaceTasks(outsider, { status: "all" }))).length).toBe(1);
    await expect(
      inAlpha(() => workspace.addComment(outsider, "task", task.id, "نظر بیننده")),
    ).rejects.toThrow(/insufficient_project_role/);
  });

  it("lets a contributor work only the tasks assigned to them", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "contributor"));
    const mine = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "مال من", assigneeUserId: alpha.memberId }),
    );
    const theirs = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "مال دیگری" }),
    );
    const member = owner(alpha.memberId);
    await expect(inAlpha(() => workspace.requireTaskWork(member, mine, false))).resolves.toBeUndefined();
    await expect(inAlpha(() => workspace.requireTaskWork(member, theirs, false)))
      .rejects.toThrow(/insufficient_project_role/);
    // Re-scoping even their own task is editor work.
    await expect(inAlpha(() => workspace.requireTaskWork(member, mine, true)))
      .rejects.toThrow(/insufficient_project_role/);
  });
});

describe("project ownership (#761)", () => {
  it("moves the owner role with owner_user_id, atomically", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.updateWorkspaceProject(owner(), project.id, { ownerUserId: alpha.memberId }),
    );
    const members = await inAlpha(() => workspace.listMembers(project.id));
    const roleOf = (id: string) => members.find((m) => m.userId === id)?.role;
    expect(roleOf(alpha.memberId)).toBe("owner");
    // The previous owner keeps access, as a manager, rather than a stale owner row.
    expect(roleOf(alpha.ownerId)).toBe("manager");
  });

  it("demotes the created_by fallback owner on a project's first transfer", async () => {
    // A pre-0193 project with no owner_user_id: its creator is the owner.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, instructions, created_by)
       VALUES ($1, 'قدیمی بی‌مالک', '', $2) RETURNING id`,
      [alpha.businessId, alpha.ownerId],
    );
    const id = rows[0].id;
    await db.query("UPDATE ai_projects SET owner_user_id = $2 WHERE id = $1", [id, alpha.memberId]);
    const members = await inAlpha(() => workspace.listMembers(id));
    const roleOf = (uid: string) => members.find((m) => m.userId === uid)?.role;
    expect(roleOf(alpha.memberId)).toBe("owner");
    expect(roleOf(alpha.ownerId)).toBe("manager");
  });

  it("refuses to demote or remove the named owner without a transfer", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "owner"));
    await expect(
      inAlpha(() => workspace.setMember(owner(), project.id, alpha.ownerId, "editor")),
    ).rejects.toThrow(/transfer_ownership_first/);
    await expect(
      inAlpha(() => workspace.removeMember(owner(), project.id, alpha.ownerId)),
    ).rejects.toThrow(/transfer_ownership_first/);
    // A co-owner who is not the named owner may step down.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
  });
});

describe("approvals (#761)", () => {
  async function draftContract(projectId: string) {
    return inAlpha(() =>
      workspace.createContract(owner(), { title: "پیمان", contractType: "vendor", projectId }),
    );
  }

  it("rejects an invalid subject and a mismatched project", async () => {
    const project = await makeProject();
    const other = await makeProject({ name: "پروژهٔ دیگر" });
    const contract = await draftContract(project.id);
    await expect(
      inAlpha(() =>
        workspace.requestApproval(owner(), { subjectType: "contract", subjectId: randomUUID() }),
      ),
    ).rejects.toThrow(/subject_not_found/);
    await expect(
      inAlpha(() =>
        workspace.requestApproval(owner(), {
          subjectType: "contract", subjectId: contract.id, projectId: other.id,
        }),
      ),
    ).rejects.toThrow(/approval_project_mismatch/);
    // The approval's project is the subject's, whatever the caller omits.
    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    expect(approval.projectId).toBe(project.id);
  });

  it("enforces the named approver, forbids self-approval, and supports request-changes", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.outsiderId, "manager"));
    const contract = await draftContract(project.id);
    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(alpha.memberId), {
        subjectType: "contract", subjectId: contract.id, approverUserId: alpha.ownerId,
      }),
    );

    // The requester can never decide their own request…
    await expect(
      inAlpha(() => workspace.decideApproval(owner(alpha.memberId), approval.id, "approved")),
    ).rejects.toThrow(/self_approval_forbidden/);
    // …and a project manager who is not the named approver cannot either.
    await expect(
      inAlpha(() => workspace.decideApproval(owner(alpha.outsiderId), approval.id, "approved")),
    ).rejects.toThrow(/not_the_approver/);

    const decided = await inAlpha(() =>
      workspace.decideApproval(owner(), approval.id, "changes_requested", "مبلغ را اصلاح کنید"),
    );
    expect(decided!.status).toBe("changes_requested");
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status)
      .toBe("draft");
  });

  it("lets an unassigned request be decided by a project manager, not a viewer", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "viewer"));
    const contract = await draftContract(project.id);
    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    await expect(
      inAlpha(() => workspace.decideApproval(owner(alpha.memberId), approval.id, "approved")),
    ).rejects.toThrow(/insufficient_project_role/);
    // The inbox flag agrees with the service, so the viewer is offered no buttons.
    const asViewer = await inAlpha(() => workspace.listApprovals(owner(alpha.memberId), { id: approval.id }));
    expect(asViewer[0].canDecideUnassigned).toBe(false);
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "manager"));
    const asManager = await inAlpha(() => workspace.listApprovals(owner(alpha.memberId), { id: approval.id }));
    expect(asManager[0].canDecideUnassigned).toBe(true);
    const decided = await inAlpha(() =>
      workspace.decideApproval(owner(alpha.memberId), approval.id, "approved"),
    );
    expect(decided!.status).toBe("approved");
  });
});

describe("comments (#761)", () => {
  it("refuses an orphan subject instead of writing a thread onto it", async () => {
    await expect(
      inAlpha(() => workspace.addComment(owner(), "task", randomUUID(), "یتیم")),
    ).rejects.toThrow(/subject_not_found/);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM workspace_comments");
    expect(rows[0].n).toBe(0);
  });
});

describe("cross-entity integrity (#761)", () => {
  it("keeps a task's phase inside the task's project", async () => {
    const project = await makeProject({ templateKey: "construction" });
    const other = await makeProject({ name: "دیگری", templateKey: "construction" });
    const [foreignPhase] = await inAlpha(() => workspace.listPhases(other.id));
    await expect(
      inAlpha(() =>
        workspace.createWorkspaceTask(owner(), project.id, { title: "x", phaseId: foreignPhase.id }),
      ),
    ).rejects.toThrow(/phase_not_in_project/);
    const task = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "y" }));
    await expect(
      inAlpha(() => workspace.updateWorkspaceTask(owner(), task.id, { phaseId: foreignPhase.id })),
    ).rejects.toThrow(/phase_not_in_project/);
  });

  it("validates a document's task, contract, media and journal links as one record", async () => {
    const project = await makeProject();
    const other = await makeProject({ name: "دیگری" });
    const foreignTask = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), other.id, { title: "کار دیگر" }),
    );
    await expect(
      inAlpha(() =>
        workspace.createDocument(owner(), { title: "d", projectId: project.id, taskId: foreignTask.id }),
      ),
    ).rejects.toThrow(/task_project_mismatch/);

    const foreignContract = await inAlpha(() =>
      workspace.createContract(owner(), { title: "c", contractType: "vendor", projectId: other.id }),
    );
    await expect(
      inAlpha(() =>
        workspace.createDocument(owner(), { title: "d", projectId: project.id, contractId: foreignContract.id }),
      ),
    ).rejects.toThrow(/contract_project_mismatch/);

    const betaMedia = await db.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'document', 'x.pdf', 'application/pdf', 1, $2, 'x') RETURNING id`,
      [beta.businessId, `k-${randomUUID()}`],
    );
    try {
      await expect(
        inAlpha(() =>
          workspace.createDocument(owner(), { title: "d", mediaAssetId: betaMedia.rows[0].id }),
        ),
      ).rejects.toThrow(/media_not_found/);
    } finally {
      // media_assets → businesses is ON DELETE RESTRICT; beforeEach deletes businesses.
      await db.query("DELETE FROM media_assets WHERE id = $1", [betaMedia.rows[0].id]);
    }

    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, project_id, created_by)
       VALUES ($1, CURRENT_DATE, 'x', $2, $3) RETURNING id`,
      [alpha.businessId, other.id, alpha.ownerId],
    );
    await expect(
      inAlpha(() =>
        workspace.createDocument(owner(), { title: "d", projectId: project.id, journalEntryId: entry.rows[0].id }),
      ),
    ).rejects.toThrow(/journal_entry_project_mismatch/);

    // A document given only a task takes that task's project.
    const ownTask = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "t" }));
    const doc = await inAlpha(() => workspace.createDocument(owner(), { title: "d", taskId: ownTask.id }));
    expect(doc.projectId).toBe(project.id);
  });

  it("keeps an event on its task's project", async () => {
    const project = await makeProject();
    const other = await makeProject({ name: "دیگری" });
    const task = await inAlpha(() => workspace.createWorkspaceTask(owner(), other.id, { title: "t" }));
    await expect(
      inAlpha(() =>
        workspace.createEvent(owner(), {
          title: "e", eventDate: "2026-03-01", projectId: project.id, taskId: task.id,
        }),
      ),
    ).rejects.toThrow(/task_project_mismatch/);
  });

  it("validates the FINAL record on a partial date update", async () => {
    const project = await makeProject({ startDate: "2026-01-05", endDate: "2026-09-30" });
    await expect(
      inAlpha(() => workspace.updateWorkspaceProject(owner(), project.id, { endDate: "2025-12-01" })),
    ).rejects.toThrow(/end_before_start/);
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "c", contractType: "vendor", startDate: "2026-02-01", endDate: "2026-06-01",
      }),
    );
    await expect(
      inAlpha(() => workspace.updateContract(owner(), contract.id, { startDate: "2026-07-01" })),
    ).rejects.toThrow(/end_before_start/);
  });
});

describe("templates (#761)", () => {
  it("re-applying a template adds nothing", async () => {
    const project = await makeProject({ templateKey: "construction" });
    const before = await inAlpha(() => workspace.listPhases(project.id));
    const tasksBefore = await inAlpha(() =>
      workspace.listWorkspaceTasks(owner(), { projectId: project.id, status: "all" }),
    );
    const templates = await inAlpha(() => workspace.listTemplates(alpha.businessId));
    const construction = templates.find((t) => t.key === "construction")!;
    const added = await inAlpha(() =>
      workspace.applyTemplate(owner(), project.id, construction, "2026-01-05"),
    );
    expect(added).toEqual({ phasesAdded: 0, tasksAdded: 0 });
    expect(await inAlpha(() => workspace.listPhases(project.id))).toHaveLength(before.length);
    expect(
      await inAlpha(() => workspace.listWorkspaceTasks(owner(), { projectId: project.id, status: "all" })),
    ).toHaveLength(tasksBefore.length);
  });
});

describe("pagination and server totals (#761)", () => {
  it("keeps totals right across pages, pages stably, and filters on the server", async () => {
    const project = await makeProject({ budgetRial: 700 });
    for (let i = 0; i < 7; i += 1) {
      await inAlpha(() =>
        workspace.createWorkspaceTask(owner(), project.id, {
          title: `کار ${i}`,
          status: i < 2 ? "done" : "open",
          // Same due date and priority for all: the ordering ties, so only the
          // id tiebreaker keeps pages from overlapping.
          dueDate: "2026-05-01",
        }),
      );
    }

    const filter = { projectId: project.id, status: "all" as const, limit: 3 };
    const seen: string[] = [];
    for (let offset = 0; offset < 9; offset += 3) {
      const rows = await inAlpha(() => workspace.listWorkspaceTasks(owner(), { ...filter, offset }));
      seen.push(...rows.map((t) => t.id));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);

    const { page, summary } = await inAlpha(() => workspace.taskListPage(owner(), { ...filter, offset: 3 }));
    expect(page).toEqual({ total: 7, offset: 3, limit: 3, hasMore: true });
    expect(summary.done).toBe(2);
    expect(summary.open).toBe(5);

    // The filter applies to the total, not just the rows.
    const open = await inAlpha(() =>
      workspace.taskListPage(owner(), { projectId: project.id, status: "open_only", limit: 3 }),
    );
    expect(open.page.total).toBe(5);

    // A non-member's totals are their own (zero), not the business's.
    const outsider = await inAlpha(() => workspace.taskListPage(owner(alpha.outsiderId), filter));
    expect(outsider.page.total).toBe(0);

    const projects = await inAlpha(() => workspace.projectListPage(owner(), { limit: 1 }));
    expect(projects.summary.budgetRial).toBe(700);
    expect(projects.summary.tasks).toBe(7);
  });
});

describe("the dependency rule (#761)", () => {
  it("refuses DONE while a task it waits on is unfinished, and allows it after", async () => {
    const project = await makeProject();
    const first = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "پی" }));
    const second = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "سقف" }));
    await inAlpha(() => workspace.addDependency(alpha.businessId, second.id, first.id));

    // Starting it is fine — the board only warns.
    await inAlpha(() => workspace.updateWorkspaceTask(owner(), second.id, { status: "in_progress" }));
    await expect(
      inAlpha(() => workspace.updateWorkspaceTask(owner(), second.id, { status: "done" })),
    ).rejects.toThrow(/dependency_unresolved/);

    await inAlpha(() => workspace.updateWorkspaceTask(owner(), first.id, { status: "done" }));
    const done = await inAlpha(() => workspace.updateWorkspaceTask(owner(), second.id, { status: "done" }));
    expect(done?.status).toBe("done");
  });
});

describe("expiring contracts are bounded (#761 review)", () => {
  it("does not count an active contract whose end date has passed as expiring", async () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await inAlpha(() =>
      workspace.createContract(owner(), { title: "گذشته", contractType: "vendor", status: "active", endDate: past }),
    );
    await inAlpha(() =>
      workspace.createContract(owner(), { title: "نزدیک", contractType: "vendor", status: "active", endDate: soon }),
    );
    const expiring = await inAlpha(() =>
      workspace.listContracts(owner(), { status: "all", expiringWithinDays: 30 }),
    );
    expect(expiring.map((c) => c.title)).toEqual(["نزدیک"]);
  });
});

describe("contract lifecycle (#761 phase E)", () => {
  it("transitions for real, refuses an illegal one, and leaves an activity record", async () => {
    const project = await makeProject();
    const soon = todayIsoDate();
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان نما", contractType: "contractor", projectId: project.id,
        status: "active", startDate: "2026-01-01", endDate: "2099-01-01",
      }),
    );
    const extended = await inAlpha(() =>
      workspace.transitionContract(owner(), contract.id, "extend", { endDate: "2099-06-01" }),
    );
    expect(extended.endDate).toBe("2099-06-01");
    await expect(
      inAlpha(() => workspace.transitionContract(owner(), contract.id, "renew", { endDate: "2100-01-01" })),
    ).rejects.toThrow(/invalid_contract_transition/);

    const terminated = await inAlpha(() => workspace.transitionContract(owner(), contract.id, "terminate", {}));
    expect(terminated.status).toBe("terminated");
    expect(terminated.endDate).toBe(soon);

    const activity = await inAlpha(() => workspace.listActivity(owner(), { projectId: project.id }));
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["contract_extend", "contract_terminate"]));
  });
});

describe("team workload (#761 phase E)", () => {
  it("counts each member's open, overdue and recently done tasks on the project", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "contributor"));
    const late = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "دیر", assigneeUserId: alpha.memberId, dueDate: "2020-01-01" }),
    );
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "باز", assigneeUserId: alpha.memberId }),
    );
    const done = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "تمام", assigneeUserId: alpha.memberId }),
    );
    await inAlpha(() => workspace.updateWorkspaceTask(owner(), done.id, { status: "done" }));
    void late;

    const member = (await inAlpha(() => workspace.listMembers(project.id))).find((m) => m.userId === alpha.memberId)!;
    expect(member.openTasks).toBe(2);
    expect(member.overdueTasks).toBe(1);
    expect(member.doneThisWeek).toBe(1);
  });
});
