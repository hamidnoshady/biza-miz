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
import { applyApprovalRepairs, buildApprovalReport } from "../src/lib/workspace-approval-report";
import { addDays, workspaceAccessFlags, type WorkspaceAccessFlags } from "../src/lib/workspace-shared";

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

/**
 * A contract in `active`, reached the way the product reaches it.
 *
 * Issue #907 F02 refuses `status: "active"` (and `pending_approval`) in a create
 * or edit payload: those two states belong to the approval engine and the
 * lifecycle commands, and a form that could set them produced the live
 * deployment's orphan «در انتظار تأیید» contract. A fixture that needs a live
 * contract therefore files a request and has it decided, exactly as a user does.
 */
async function activeContract(input: {
  title: string;
  contractType?: string;
  projectId?: string;
  startDate?: string;
  endDate?: string;
  valueRial?: number;
}) {
  const contract = await inAlpha(() =>
    workspace.createContract(owner(), {
      title: input.title,
      contractType: input.contractType ?? "vendor",
      projectId: input.projectId,
      startDate: input.startDate,
      endDate: input.endDate,
      valueRial: input.valueRial,
    }),
  );
  const approval = await inAlpha(() =>
    workspace.requestApproval(owner(), {
      subjectType: "contract",
      subjectId: contract.id,
      approverUserId: alpha.memberId,
    }),
  );
  await inAlpha(() => workspace.decideApproval(owner(alpha.memberId), approval.id, "approved"));
  return (await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!;
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
    // The old path knows nothing about workspace_members; the 0194 trigger
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
    // A draft contract still owns its expiry date on the calendar (the union
    // deliberately excludes only terminated/completed ones), and issue #907 F02
    // means `active` can no longer be typed into a create payload.
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان تأسیسات",
        contractType: "supplier",
        projectId: project.id,
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

  it("counts the deadlines its own list shows, not just task due dates (issue #907 F06)", async () => {
    /*
     * The live screen showed «۰ مهلت پیش‌رو» above a list whose first row was a
     * contract expiring that day: the KPI counted `ai_project_tasks.due_date`
     * only, while the list unioned five sources. There is no task in this
     * fixture at all — just a contract expiring today — so the only way the two
     * can agree is if they are the same query.
     */
    const project = await makeProject();
    const today = todayIsoDate();
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان امروز منقضی می‌شود",
        contractType: "supplier",
        projectId: project.id,
        endDate: today,
      }),
    );
    // A meeting in the same window is on the calendar but is not a deadline.
    await inAlpha(() =>
      workspace.createEvent(owner(), {
        title: "جلسهٔ هفتگی",
        kind: "meeting",
        eventDate: today,
        projectId: project.id,
      }),
    );

    const until = addDays(today, 14);
    const [dash, entries] = await Promise.all([
      inAlpha(() => workspace.getWorkspaceDashboard(owner())),
      inAlpha(() => workspace.listCalendar(owner(), { from: today, to: until })),
    ]);

    const deadlines = entries.filter((entry) => entry.source !== "event");
    expect(deadlines.map((entry) => entry.source)).toContain("contract_expiry");
    // One fact, two readings: the KPI and the list cannot disagree.
    expect(dash.upcomingDeadlines).toBe(deadlines.length);
    expect(dash.upcomingDeadlines).toBe(1);
    expect(dash.calendarEntries).toBe(entries.length);
    expect(dash.calendarEntries).toBe(2);
    expect(dash.deadlines.length).toBeLessThanOrEqual(10);
  });

  it("gives a project one health verdict on every surface (issue #907 F07)", async () => {
    /*
     * The card and «گزارش‌ها» said on track while the cockpit, which counted the
     * expiring contract, said at risk — the other two passed
     * `expiringContracts: 0`. All three now read the server's snapshot.
     */
    const today = todayIsoDate();
    const project = await makeProject({ startDate: addDays(today, -30), endDate: addDays(today, 60) });
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان رو به انقضا",
        contractType: "supplier",
        projectId: project.id,
        // Inside the contracts list's own 30-day window.
        endDate: addDays(today, 10),
      }),
    );

    const [listed, cockpit, [report]] = await Promise.all([
      inAlpha(() => workspace.listWorkspaceProjects(owner())),
      inAlpha(() => workspace.getWorkspaceProjectWithHealth(owner(), project.id)),
      inAlpha(() => workspace.projectReport(owner(), { projectId: project.id })),
    ]);
    const card = listed.find((row) => row.id === project.id);
    expect(card).toBeDefined();
    expect(cockpit).not.toBeNull();

    expect(card!.expiringContractCount).toBe(1);
    expect(card!.health).toEqual(cockpit!.health);
    expect(card!.health.health).toBe(report.health.health);
    expect(card!.health.reasons).toContain("contracts_expiring");
    expect(card!.health.health).toBe("at_risk");
    // The verdict belongs to a day, and that day is the business's.
    expect(card!.health.day).toBe(today);

    // The window is bounded on both sides: a contract that has already lapsed
    // is overdue, not "expiring", on the card as in the contracts list.
    const lapsed = await makeProject({ name: "پروژهٔ دیگر" });
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان گذشته",
        contractType: "supplier",
        projectId: lapsed.id,
        endDate: addDays(today, -3),
      }),
    );
    const again = await inAlpha(() => workspace.listWorkspaceProjects(owner()));
    const lapsedRow = again.find((row) => row.id === lapsed.id)!;
    expect(lapsedRow.expiringContractCount).toBe(0);
    expect(lapsedRow.health.reasons).not.toContain("contracts_expiring");
  });

  it("reads project cost as the accounting domain defines it — net expense, not every debit", async () => {
    /*
     * Issue #907 F04. The old figure summed every debit on the project's
     * entries, so a project SALE (debit receivables) raised "spend" and an
     * expense that was REVERSED still counted in full. The canonical query
     * counts expense accounts only and nets credits — and follows a reversal
     * back to the project it reverses, because the reversal row itself carries
     * no project_id.
     */
    const project = await makeProject({ budgetRial: 1_000_000 });
    const accounts = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '6001', 'هزینهٔ پروژه', 'expense'),
              ($1, '1101', 'حساب‌های دریافتنی', 'asset'),
              ($1, '4001', 'درآمد پروژه', 'revenue')
       RETURNING id, code`,
      [alpha.businessId],
    );
    const accountId = (code: string) => accounts.rows.find((row) => row.code === code)!.id;
    async function postEntry(input: {
      memo: string;
      projectId: string | null;
      reversesEntryId?: string | null;
      lines: Array<{ account: string; debit?: number; credit?: number }>;
    }) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO journal_entries (business_id, entry_date, memo, project_id, created_by, reverses_entry_id)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5) RETURNING id`,
        [alpha.businessId, input.memo, input.projectId, alpha.ownerId, input.reversesEntryId ?? null],
      );
      for (const line of input.lines) {
        await db.query(
          `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
          [rows[0].id, accountId(line.account), line.debit ?? 0, line.credit ?? 0],
        );
      }
      return rows[0].id;
    }

    // 250,000 of material cost, then a sale of 900,000 against the project.
    const cost = await postEntry({
      memo: "خرید مصالح",
      projectId: project.id,
      lines: [{ account: "6001", debit: 250_000 }],
    });
    await postEntry({
      memo: "فروش",
      projectId: project.id,
      lines: [{ account: "1101", debit: 900_000 }, { account: "4001", credit: 900_000 }],
    });

    const [before] = await inAlpha(() => workspace.projectReport(owner()));
    // Receivable debits are not cost. This is the exact figure the old query
    // got wrong (it would have said 1,150,000).
    expect(before.spentRial).toBe(250_000);

    // The expense is undone the way Accounting undoes one — a posted reversal —
    // and that reversal is filed WITHOUT the project, as the A/P and manual
    // reversal writers do today.
    await postEntry({
      memo: "برگشت خرید مصالح",
      projectId: null,
      reversesEntryId: cost,
      lines: [{ account: "6001", credit: 250_000 }],
    });

    const [after] = await inAlpha(() => workspace.projectReport(owner()));
    expect(after.spentRial).toBe(0);
    // Budget − cost is a variance the screen calls «مانده», not "profit".
    expect(after.budgetRial! - after.spentRial!).toBe(1_000_000);
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
    // A pre-0194 project with no owner_user_id: its creator is the owner.
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
    expect(added).toMatchObject({ phasesAdded: 0, tasksAdded: 0 });
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
    await activeContract({ title: "گذشته", endDate: past });
    await activeContract({ title: "نزدیک", endDate: soon });
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
    const contract = await activeContract({
      title: "پیمان نما", contractType: "contractor", projectId: project.id,
      startDate: "2026-01-01", endDate: "2099-01-01",
    });
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

describe("calendar events are editable (#761 phase F)", () => {
  it("lets the author edit, refuses an outsider, and checks the final times", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createEvent(owner(), {
        title: "جلسه", eventDate: "2026-03-10", startTime: "09:00", endTime: "10:00", projectId: project.id,
      }),
    );
    const { rows } = await db.query<{ id: string }>("SELECT id FROM workspace_events WHERE title = 'جلسه'");
    const id = rows[0].id;
    await inAlpha(() => workspace.updateEvent(owner(), id, { title: "جلسهٔ کارگاه", description: "با پیمانکار" }));
    const [entry] = await inAlpha(() => workspace.listCalendar(owner(), { from: "2026-03-10", to: "2026-03-10" }));
    expect(entry.title).toBe("جلسهٔ کارگاه");
    expect(entry.description).toBe("با پیمانکار");
    // Only the start moves, past the stored end: the FINAL record is refused.
    await expect(
      inAlpha(() => workspace.updateEvent(owner(), id, { startTime: "11:00" })),
    ).rejects.toThrow(/end_before_start/);
    await expect(
      inAlpha(() => workspace.updateEvent(owner(alpha.outsiderId), id, { title: "x" })),
    ).rejects.toThrow(/project_not_found/);
  });
});

describe("insights (#761 phase F)", () => {
  it("answers over visible projects only, naming the records", async () => {
    const project = await makeProject({ startDate: "2025-01-01", endDate: "2025-06-01" });
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "دیرکرد", dueDate: "2025-02-01", assigneeUserId: alpha.memberId,
      }),
    );
    const mine = await inAlpha(() => workspace.workspaceInsights(owner()));
    expect(mine.atRisk.map((p) => p.projectId)).toContain(project.id);
    expect(mine.atRisk.find((p) => p.projectId === project.id)?.reasons).toContain("past_deadline");
    expect(mine.slipping.map((t) => t.title)).toContain("دیرکرد");
    expect(mine.overloaded.find((m) => m.userId === alpha.memberId)?.overdueTasks).toBe(1);

    const outsider = await inAlpha(() => workspace.workspaceInsights(owner(alpha.outsiderId)));
    expect(outsider.atRisk).toEqual([]);
    expect(outsider.slipping).toEqual([]);
    expect(outsider.overspending).toBeNull();
  });
});

describe("template recipes (#761 phase F)", () => {
  it("previews without writing, and replace removes only empty phases", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.addPhase(owner(), project.id, { name: "فاز خالی" }));
    const [busy] = await inAlpha(() => workspace.addPhase(owner(), project.id, { name: "فاز پر" }))
      .then((phases) => phases.filter((p) => p.name === "فاز پر"));
    await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "کار", phaseId: busy.id }));
    const templates = await inAlpha(() => workspace.listTemplates(alpha.businessId));
    const construction = templates.find((t) => t.key === "construction")!;

    const preview = await inAlpha(() =>
      workspace.applyTemplate(owner(), project.id, construction, null, { mode: "replace", dryRun: true }),
    );
    expect(preview.removePhases.map((p) => p.name)).toEqual(["فاز خالی"]);
    expect(preview.addPhases.length).toBeGreaterThan(0);
    // A dry run wrote nothing.
    expect((await inAlpha(() => workspace.listPhases(project.id))).map((p) => p.name)).toEqual(["فاز خالی", "فاز پر"]);

    await inAlpha(() => workspace.applyTemplate(owner(), project.id, construction, null, { mode: "replace" }));
    const names = (await inAlpha(() => workspace.listPhases(project.id))).map((p) => p.name);
    expect(names).not.toContain("فاز خالی");
    expect(names).toContain("فاز پر");
    expect(names.length).toBe(1 + preview.addPhases.length);
  });
});

describe("portfolio health inputs (#761 §7)", () => {
  it("carries overdue tasks and open approvals on every project row", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "دیر", dueDate: "2020-01-01" }));
    await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "به‌موقع", dueDate: "2099-01-01" }));
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), { title: "پیمان", contractType: "vendor", projectId: project.id }),
    );
    await inAlpha(() => workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }));
    const [row] = await inAlpha(() => workspace.listWorkspaceProjects(owner(), { status: "all" }));
    expect(row.overdueTaskCount).toBe(1);
    expect(row.openApprovalCount).toBe(1);
  });
});

/* ===========================================================================
 * Issue #907 — the authorization, workflow-state and approval-integrity slice
 * ======================================================================== */

describe("issue #907 F01 — a same-tenant caller needs a project role", () => {
  it("refuses task work to a member of the business who is not on the project", async () => {
    const project = await makeProject();
    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "کار پروژه" }),
    );
    // The legacy assistant route's caller: a real, signed-in colleague of the
    // same business — exactly what `getSession()` used to accept.
    const outsider = owner(alpha.outsiderId);
    await expect(
      inAlpha(() => workspace.requireTaskWork(outsider, task, false)),
    ).rejects.toThrow(/project_not_found/);
    await expect(
      inAlpha(() => workspace.requireProjectCapability(outsider, project.id, "view")),
    ).rejects.toThrow(/project_not_found/);
  });

  it("lets a viewer read but not work a task, and a contributor only the task assigned to them", async () => {
    const project = await makeProject();
    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "کار تیم" }),
    );
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "viewer"));
    expect(await inAlpha(() => workspace.requireProjectCapability(owner(alpha.memberId), project.id, "view")))
      .toBe("viewer");
    await expect(
      inAlpha(() => workspace.requireTaskWork(owner(alpha.memberId), task, false)),
    ).rejects.toThrow(/insufficient_project_role/);

    // A contributor may work only what was given to them — the same rule the
    // task drawer enforces, now on the assistant's route as well.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "contributor"));
    await expect(
      inAlpha(() => workspace.requireTaskWork(owner(alpha.memberId), task, false)),
    ).rejects.toThrow(/insufficient_project_role/);
    const assigned = await inAlpha(() =>
      workspace.updateWorkspaceTask(owner(), task.id, { assigneeUserId: alpha.memberId }),
    );
    expect(assigned?.assigneeUserId).toBe(alpha.memberId);
    await expect(
      inAlpha(() => workspace.requireTaskWork(owner(alpha.memberId), assigned!, false)),
    ).resolves.toBeUndefined();
    // …but re-scoping it is still editor work.
    await expect(
      inAlpha(() => workspace.requireTaskWork(owner(alpha.memberId), assigned!, true)),
    ).rejects.toThrow(/insufficient_project_role/);
  });

  it("keeps the dependency rule on the one command both routes use", async () => {
    const project = await makeProject();
    const first = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "پایه" }));
    const second = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "سقف" }));
    await inAlpha(() => workspace.addDependency(alpha.businessId, second.id, first.id));
    // The assistant route's {done:true} is this call — it is refused, which is
    // what the bypassed `setTaskStatus` never checked.
    await expect(
      inAlpha(() => workspace.updateWorkspaceTask(owner(), second.id, { status: "done" })),
    ).rejects.toThrow(/dependency_unresolved/);
  });
});

describe("issue #907 F02 — workflow states belong to their commands", () => {
  it("refuses a contract created as pending approval or active", async () => {
    for (const status of ["pending_approval", "active"] as const) {
      await expect(
        inAlpha(() => workspace.createContract(owner(), { title: "پیمان", contractType: "vendor", status })),
      ).rejects.toThrow(/contract_status_requires_workflow/);
    }
  });

  it("refuses an edit into — or out of — a decided contract state", async () => {
    const project = await makeProject();
    const draft = await inAlpha(() =>
      workspace.createContract(owner(), { title: "پیش‌نویس", contractType: "vendor", projectId: project.id }),
    );
    await expect(
      inAlpha(() => workspace.updateContract(owner(), draft.id, { status: "active" })),
    ).rejects.toThrow(/contract_status_requires_workflow/);

    const live = await activeContract({ title: "جاری", projectId: project.id });
    expect(live.status).toBe("active");
    await expect(
      inAlpha(() => workspace.updateContract(owner(), live.id, { status: "draft" })),
    ).rejects.toThrow(/contract_status_requires_workflow/);
    // Lifecycle commands still move it, and so does a factual correction that
    // touches no workflow-owned state.
    const terminated = await inAlpha(() => workspace.transitionContract(owner(), live.id, "terminate", {}));
    expect(terminated.status).toBe("terminated");
    const corrected = await inAlpha(() =>
      workspace.updateContract(owner(), draft.id, { status: "terminated" }),
    );
    expect(corrected?.status).toBe("terminated");
  });

  it("refuses a document created or edited into the approval engine's states", async () => {
    for (const status of ["in_review", "approved"] as const) {
      await expect(
        inAlpha(() => workspace.createDocument(owner(), { title: "سند", status })),
      ).rejects.toThrow(/document_status_requires_workflow/);
    }
    const document = await inAlpha(() => workspace.createDocument(owner(), { title: "سند" }));
    await expect(
      inAlpha(() => workspace.updateDocument(owner(), document.id, { status: "approved" })),
    ).rejects.toThrow(/document_status_requires_workflow/);
    // Archiving a draft is an ordinary edit.
    const archived = await inAlpha(() =>
      workspace.updateDocument(owner(), document.id, { status: "archived" }),
    );
    expect(archived?.status).toBe("archived");
  });
});

describe("issue #907 F03 — one pending request per subject, and no orphan states", () => {
  async function draftContractFor(projectId: string) {
    return inAlpha(() =>
      workspace.createContract(owner(), { title: "پیمان تأیید", contractType: "vendor", projectId }),
    );
  }

  it("is enforced by the database, not by a read-then-write check", async () => {
    const project = await makeProject();
    // A colleague who may see the subject — a non-member is refused earlier, as
    // `subject_not_found`, because whether the contract exists is itself
    // something a non-member must not learn.
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    const contract = await draftContractFor(project.id);
    await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    // The constraint the command layer relies on: partial on `pending`, so
    // decided and cancelled rows stay free to accumulate as history.
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_workspace_approvals_one_pending'`,
    );
    expect(rows[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(rows[0]?.indexdef).toContain("status = 'pending'");
    // …and a second requester is refused by the command above it.
    await expect(
      inAlpha(() =>
        workspace.requestApproval(owner(alpha.memberId), {
          subjectType: "contract", subjectId: contract.id,
        }),
      ),
    ).rejects.toThrow(/approval_already_pending/);
  });

  it("refuses a second requester and answers a retry with the same request", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    const contract = await draftContractFor(project.id);

    const first = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    // A retry from the same person is idempotent: one request, same id.
    const retry = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    expect(retry.id).toBe(first.id);
    // Anybody else is a conflict, not a second request.
    await expect(
      inAlpha(() => workspace.requestApproval(owner(alpha.memberId), {
        subjectType: "contract", subjectId: contract.id,
      })),
    ).rejects.toThrow(/approval_already_pending/);
    const pending = await inAlpha(() =>
      workspace.listApprovals(owner(), { subjectType: "contract", subjectId: contract.id, status: "pending" }),
    );
    expect(pending).toHaveLength(1);
  });

  it("reopens the subject when the only pending request is withdrawn", async () => {
    const project = await makeProject();
    const contract = await draftContractFor(project.id);
    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status)
      .toBe("pending_approval");

    const cancelled = await inAlpha(() => workspace.decideApproval(owner(), approval.id, "cancelled"));
    expect(cancelled!.status).toBe("cancelled");
    // The orphan state the live deployment showed is gone: the contract is a
    // draft again, so «request approval» is offered and accepted.
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe("draft");
    const again = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "contract", subjectId: contract.id }),
    );
    expect(again.status).toBe("pending");
  });

  it("does the same for a document in review", async () => {
    const document = await inAlpha(() => workspace.createDocument(owner(), { title: "سند بازنگری" }));
    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), { subjectType: "document", subjectId: document.id }),
    );
    expect((await inAlpha(() => workspace.getDocument(alpha.businessId, document.id)))!.status).toBe("in_review");
    await inAlpha(() => workspace.decideApproval(owner(), approval.id, "cancelled"));
    expect((await inAlpha(() => workspace.getDocument(alpha.businessId, document.id)))!.status).toBe("draft");
  });

  it("refuses to put a live contract up for approval at all", async () => {
    const project = await makeProject();
    const live = await activeContract({ title: "جاری", projectId: project.id });
    await expect(
      inAlpha(() => workspace.requestApproval(owner(), { subjectType: "contract", subjectId: live.id })),
    ).rejects.toThrow(/subject_not_requestable/);
  });
});

describe("issue #907 F02 — an automation cannot write a workflow state either", () => {
  /*
   * The autopilot executors pass whatever the payload names straight through to
   * `createContract` / `updateContract` / `createDocument` / `updateDocument`,
   * so the new gates apply to them unchanged. The choice made here is explicit:
   * the executor REFUSES with the same domain code an HTTP caller gets, rather
   * than quietly dropping `status` from the payload. Dropping it would turn a
   * proposal that says «قرارداد فعال بساز» into a silent draft, and the operator
   * reviewing the automation's output would see a write that does not match the
   * proposal they approved.
   */
  let executors: typeof import("../src/lib/ai-autopilot-executors");

  beforeAll(async () => {
    executors = await import("../src/lib/ai-autopilot-executors");
  });

  function context(payload: Record<string, unknown>) {
    return { businessId: alpha.businessId, authorizedByUserId: alpha.ownerId, payload };
  }

  it("refuses a contract created straight into a workflow state, and still creates a draft", async () => {
    const refused = await inAlpha(() =>
      executors.AUTOPILOT_EXECUTORS.contractCreate(context({ title: "قرارداد خودکار", status: "active" })),
    );
    expect(refused.ok).toBe(false);
    expect(refused.errorCode).toBe("contract_status_requires_workflow");

    // The same executor, without the workflow state, is what the automation is
    // supposed to do: raise a draft the human then sends for approval.
    const created = await inAlpha(() =>
      executors.AUTOPILOT_EXECUTORS.contractCreate(context({ title: "قرارداد خودکار" })),
    );
    expect(created.ok).toBe(true);
    const contract = (created.result as { contract: { id: string; status: string } }).contract;
    expect(contract.status).toBe("draft");
  });

  it("refuses a document created or edited into a workflow state", async () => {
    const refusedCreate = await inAlpha(() =>
      executors.AUTOPILOT_EXECUTORS.workspaceDocumentCreate(context({ title: "سند خودکار", status: "approved" })),
    );
    expect(refusedCreate.ok).toBe(false);
    expect(refusedCreate.errorCode).toBe("document_status_requires_workflow");

    const created = await inAlpha(() =>
      executors.AUTOPILOT_EXECUTORS.workspaceDocumentCreate(context({ title: "سند خودکار" })),
    );
    expect(created.ok).toBe(true);
    const id = (created.result as { id: string }).id;
    const refusedUpdate = await inAlpha(() =>
      executors.AUTOPILOT_EXECUTORS.workspaceDocumentUpdate(context({ documentId: id, status: "approved" })),
    );
    expect(refusedUpdate.ok).toBe(false);
    expect(refusedUpdate.errorCode).toBe("document_status_requires_workflow");
    // Nothing was written by the refused edit.
    expect((await inAlpha(() => workspace.getDocument(alpha.businessId, id)))!.status).toBe("draft");
  });
});

describe("issue #907 F03 — the reconciliation report and its authorized repair", () => {
  /*
   * The two shapes the issue's third instruction names — orphan pending states
   * and duplicate live requests — are unreachable from an ordinary screen once
   * F02/F03 are in place: an edit may neither enter nor leave a workflow state,
   * and `requestApproval` refuses a subject that is not a draft. So the removal
   * path has to be explicit and audited, and this is it: a report that writes
   * nothing, and a repair that runs only when asked and records what it moved.
   */

  /** A draft contract, the only state a request may be raised from (F03). */
  async function draftContract(projectId: string) {
    return inAlpha(() =>
      workspace.createContract(owner(), { title: "قرارداد پیش‌نویس", contractType: "vendor", projectId }),
    );
  }

  /** A row in the shape the pre-fix forms could write and then not undo. */
  async function strandedContract() {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO workspace_contracts (business_id, title, contract_type, status)
       VALUES ($1, 'قرارداد بی‌درخواست', 'vendor', 'pending_approval') RETURNING id`,
      [alpha.businessId],
    );
    return rows[0].id;
  }

  it("reports a stranded contract, touches nothing, and repairs it only when asked", async () => {
    const id = await strandedContract();

    const before = await buildApprovalReport(db, alpha.businessId);
    const stranded = before.orphanSubjects.find((row) => row.subjectId === id);
    expect(stranded).toBeTruthy();
    expect(stranded!.subjectType).toBe("contract");
    expect(stranded!.status).toBe("pending_approval");
    expect(stranded!.title).toBe("قرارداد بی‌درخواست");
    // The finding names a command that exists; the F02 gate is why an ordinary
    // edit cannot be the answer here.
    expect(stranded!.remediation).toContain("--apply");
    await expect(
      inAlpha(() => workspace.updateContract(owner(), id, { status: "draft" })),
    ).rejects.toThrow(/contract_status_requires_workflow/);
    // Still stranded: the report wrote nothing.
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, id)))!.status).toBe("pending_approval");

    const outcome = await applyApprovalRepairs(db, before, { businessId: alpha.businessId });
    expect(outcome.reverted).toEqual([
      { subjectType: "contract", subjectId: id, title: "قرارداد بی‌درخواست" },
    ]);
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, id)))!.status).toBe("draft");
    // The repair is in the feed, not only in the script's stdout.
    const activity = await db.query<{ action: string; summary: string }>(
      `SELECT action, summary FROM workspace_activity
        WHERE business_id = $1 AND subject_type = 'contract' AND subject_id = $2`,
      [alpha.businessId, id],
    );
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].action).toBe("approval_reconciled");

    // Clean now, and a second run is a no-op rather than a second repair.
    const after = await buildApprovalReport(db, alpha.businessId);
    expect(after.orphanSubjects.map((row) => row.subjectId)).not.toContain(id);
    const again = await applyApprovalRepairs(db, after, { businessId: alpha.businessId });
    expect(again).toEqual({ cancelled: [], reverted: [], skipped: [] });
  });

  it("finds a document stranded in review, and never a subject that has a live request", async () => {
    const stranded = await inAlpha(() => workspace.createDocument(owner(), { title: "نقشه بی‌درخواست" }));
    await db.query(`UPDATE workspace_documents SET status = 'in_review' WHERE id = $1`, [stranded.id]);
    // A contract that IS waiting on a request must never be reported: that is a
    // legitimate state, not an orphan.
    const project = await makeProject();
    const waiting = await draftContract(project.id);
    await inAlpha(() => workspace.requestApproval(owner(), { subjectType: "contract", subjectId: waiting.id }));

    const report = await buildApprovalReport(db, alpha.businessId);
    expect(report.orphanSubjects.map((row) => row.subjectId)).toContain(stranded.id);
    expect(report.orphanSubjects.map((row) => row.subjectId)).not.toContain(waiting.id);
    const entry = report.orphanSubjects.find((row) => row.subjectId === stranded.id)!;
    expect(entry.subjectType).toBe("document");
    expect(entry.remediation).toContain("--apply");

    const outcome = await applyApprovalRepairs(db, report, { businessId: alpha.businessId });
    expect(outcome.reverted.map((row) => row.subjectId)).toEqual([stranded.id]);
    expect((await inAlpha(() => workspace.getDocument(alpha.businessId, stranded.id)))!.status).toBe("draft");
    // The contract waiting on its request was not touched.
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, waiting.id)))!.status)
      .toBe("pending_approval");
  });

  it("leaves a subject alone when it moved between the report and the repair", async () => {
    const id = await strandedContract();
    const report = await buildApprovalReport(db, alpha.businessId);
    // Somebody reconciled it by hand (or a request landed) after the printout.
    await db.query(`UPDATE workspace_contracts SET status = 'draft' WHERE id = $1`, [id]);

    const outcome = await applyApprovalRepairs(db, report, { businessId: alpha.businessId });
    expect(outcome.reverted).toHaveLength(0);
    expect(outcome.skipped).toEqual([
      expect.objectContaining({ subjectType: "contract", subjectId: id }),
    ]);
    const activity = await db.query(
      `SELECT 1 FROM workspace_activity
        WHERE business_id = $1 AND subject_id = $2 AND action = 'approval_reconciled'`,
      [alpha.businessId, id],
    );
    expect(activity.rows).toHaveLength(0);
  });

  it("cancels the older duplicates, keeps the newest, and never crosses the tenant", async () => {
    const project = await makeProject();
    const contract = await draftContract(project.id);

    // Two live requests on one subject is exactly what the database refuses
    // since 0258. To exercise the report's own logic the index is lifted for the
    // length of this test — which is also the honest simulation of the pre-0258
    // data the report exists to find.
    await db.query("DROP INDEX uq_workspace_approvals_one_pending");
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO workspace_approvals (business_id, subject_type, subject_id, title, requested_by, created_at)
         VALUES ($1, 'contract', $2, 'قدیمی', $3, now() - interval '2 hours'),
                ($1, 'contract', $2, 'تازه', $4, now())
         RETURNING id`,
        [alpha.businessId, contract.id, alpha.ownerId, alpha.memberId],
      );
      const report = await buildApprovalReport(db, alpha.businessId);
      const group = report.duplicateRequests.find((row) => row.subjectId === contract.id);
      expect(group).toBeTruthy();
      expect(group!.pending).toHaveLength(2);
      // Newest first, and only the newest is kept — the same choice 0258 makes.
      expect(group!.pending.filter((row) => row.keeps)).toHaveLength(1);
      expect(group!.pending[0].keeps).toBe(true);
      expect(group!.pending[0].approvalId).toBe(rows[1].id);
      expect(group!.pending[0].requestedByName).toBe("عضو تیم");
      expect(group!.pending[1].approvalId).toBe(rows[0].id);

      // A report asked for another tenant is empty even while that scope is
      // ambient: the filter is in the SQL, not only in the caller.
      const scoped = await buildApprovalReport(db, beta.businessId);
      expect(scoped.duplicateRequests).toHaveLength(0);
      expect(scoped.orphanSubjects).toHaveLength(0);

      const outcome = await applyApprovalRepairs(db, report, { businessId: alpha.businessId });
      expect(outcome.cancelled.map((row) => row.approvalId)).toEqual([rows[0].id]);
      const statuses = await db.query<{ id: string; status: string; note: string }>(
        `SELECT id, status, note FROM workspace_approvals WHERE subject_id = $1 ORDER BY created_at`,
        [contract.id],
      );
      expect(statuses.rows.map((row) => row.status)).toEqual(["cancelled", "pending"]);
      // History is annotated, never deleted.
      expect(statuses.rows[0].note).toContain("#907");
      expect(statuses.rows[1].note).toBe("");

      // The repair cancels requests and nothing else: it does not activate the
      // contract, move it into a workflow state, or otherwise invent a decision.
      expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe("draft");
    } finally {
      await db.query("DELETE FROM workspace_approvals WHERE subject_id = $1 AND subject_type = 'contract'", [contract.id]);
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_approvals_one_pending
           ON workspace_approvals (business_id, subject_type, subject_id) WHERE status = 'pending'`,
      );
    }
  });
});

describe("issue #907 F15 — dependency and revision chains are serialized", () => {
  /*
   * Both defects are read-then-write checks: the reader and the writer are in
   * different statements, so two requests can each pass the check and both
   * write. These tests issue the two requests concurrently against the real
   * database, which is the only place the interleaving can be shown.
   */

  it("waits for the project lock before deciding, so the interleaving cannot split", async () => {
    /*
     * The deterministic reproduction. Another writer holds the project's
     * dependency graph (the lock `addDependency` takes) with an uncommitted A→B
     * edge. A B→A request issued now must NOT read the graph and pass: it blocks
     * until the first writer commits, and only then decides — which is exactly
     * the interleaving that used to produce a cycle.
     */
    const project = await makeProject();
    const a = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "الف" }));
    const b = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "ب" }));

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM ai_projects WHERE id = $1 FOR UPDATE", [project.id]);
      await holder.query(
        `INSERT INTO workspace_task_dependencies (task_id, depends_on_id) VALUES ($1, $2)`,
        [a.id, b.id],
      );

      const pending = inAlpha(() => workspace.addDependency(alpha.businessId, b.id, a.id));
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      // Give it every chance to slip through; it must still be waiting.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled).toBe(false);

      await holder.query("COMMIT");
      // Now it sees the committed edge and refuses, instead of writing the cycle.
      await expect(pending).rejects.toThrow(/dependency_cycle/);
      const { rows } = await db.query(
        `SELECT 1 FROM workspace_task_dependencies WHERE task_id = $1 AND depends_on_id = $2`,
        [b.id, a.id],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });

  it("lets only one of two simultaneous opposite dependencies through", async () => {
    const project = await makeProject();
    const a = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "الف" }));
    const b = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "ب" }));

    // A→B and B→A at the same moment: at most one may survive, because either
    // one alone makes the other a cycle.
    const results = await Promise.allSettled([
      inAlpha(() => workspace.addDependency(alpha.businessId, a.id, b.id)),
      inAlpha(() => workspace.addDependency(alpha.businessId, b.id, a.id)),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/dependency_cycle/);

    // And the graph really holds one edge, in one direction.
    const { rows } = await db.query<{ task_id: string; depends_on_id: string }>(
      `SELECT task_id, depends_on_id FROM workspace_task_dependencies WHERE task_id IN ($1, $2)`,
      [a.id, b.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a cycle even when the edges are added one after another", async () => {
    const project = await makeProject();
    const a = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "۱" }));
    const b = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "۲" }));
    const c = await inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "۳" }));
    await inAlpha(() => workspace.addDependency(alpha.businessId, a.id, b.id));
    await inAlpha(() => workspace.addDependency(alpha.businessId, b.id, c.id));
    // The long cycle the CHECK cannot see: C→A closes 3 → 1 → 2 → 3.
    await expect(
      inAlpha(() => workspace.addDependency(alpha.businessId, c.id, a.id)),
    ).rejects.toThrow(/dependency_cycle/);
  });

  it("gives a revision chain exactly one successor, even under two simultaneous revisions", async () => {
    const first = await inAlpha(() => workspace.createDocument(owner(), { title: "نقشهٔ اصلی" }));

    const results = await Promise.allSettled([
      inAlpha(() => workspace.createDocument(owner(), { title: "بازنگری ۱", supersedesId: first.id })),
      inAlpha(() => workspace.createDocument(owner(), { title: "بازنگری ۲", supersedesId: first.id })),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[];
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    // One v2, and the other request told why rather than silently forking.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/document_already_superseded/);
    expect(fulfilled[0].value.id).not.toBe(first.id);

    const chain = await db.query<{ id: string; version: number; supersedes_id: string | null }>(
      `SELECT id, version, supersedes_id FROM workspace_documents
        WHERE supersedes_id = $1 AND business_id = $2`,
      [first.id, alpha.businessId],
    );
    expect(chain.rows).toHaveLength(1);
    expect(chain.rows[0].version).toBe(2);
  });

  it("holds the one-successor rule in the database, not only in the service", async () => {
    const first = await inAlpha(() => workspace.createDocument(owner(), { title: "نسخهٔ ۱" }));
    await inAlpha(() => workspace.createDocument(owner(), { title: "نسخهٔ ۲", supersedesId: first.id }));

    // A writer that never runs `createDocument` cannot fork the chain either:
    // 0259's trigger refuses the second successor and names the rule.
    await expect(
      db.query(
        `INSERT INTO workspace_documents (business_id, title, version, supersedes_id)
         VALUES ($1, 'نسخهٔ جعلی', 2, $2)`,
        [alpha.businessId, first.id],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "workspace_documents_one_successor" });
  });
});

describe("issue #907 F16 — a wrong type is a field error, not a server error", () => {
  /*
   * Every one of these used to be reachable from a JSON body and answered with
   * a TypeError (numeric text), a Postgres error (an impossible date, or a
   * reminder window past the CHECK), or a silent accept that the database then
   * refused. The point is not the code as such but that the API layer maps each
   * of them to 400 via `ERROR_STATUS` — none is a 500.
   */

  it("refuses a numeric title with a domain code instead of a TypeError", async () => {
    await expect(
      inAlpha(() => workspace.createDocument(owner(), { title: 12345 as unknown as string })),
    ).rejects.toThrow(/invalid_text_field/);
    // The same guard covers every text field, including the optional ones.
    const project = await makeProject();
    await expect(
      inAlpha(() =>
        workspace.createWorkspaceProject(owner(), { name: "پروژه", description: {} as unknown as string }),
      ),
    ).rejects.toThrow(/invalid_text_field/);
    // …and the required-text checks still fire for a genuinely absent value.
    await expect(
      inAlpha(() => workspace.createWorkspaceTask(owner(), project.id, { title: "   " })),
    ).rejects.toThrow(/task_title_required/);
  });

  it("refuses a date-shaped value that is not a day on the calendar", async () => {
    const project = await makeProject();
    await expect(
      inAlpha(() =>
        workspace.createWorkspaceProject(owner(), { name: "پروژه", startDate: "2026-02-31" }),
      ),
    ).rejects.toThrow(/invalid_date/);
    // A real leap day is still accepted.
    const leap = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "کار", dueDate: "2028-02-29" }),
    );
    expect(leap.dueDate).toBe("2028-02-29");
  });

  it("refuses a reminder window the column does not allow, and accepts its ceiling", async () => {
    await expect(
      inAlpha(() => workspace.createContract(owner(), { title: "پیمان", reminderDays: 366 })),
    ).rejects.toThrow(/invalid_reminder_days/);
    const atCeiling = await inAlpha(() =>
      workspace.createContract(owner(), { title: "پیمان", reminderDays: 365 }),
    );
    expect(atCeiling.reminderDays).toBe(365);
    // The edit path is bounded too, not only create.
    await expect(
      inAlpha(() => workspace.updateContract(owner(), atCeiling.id, { reminderDays: 400 })),
    ).rejects.toThrow(/invalid_reminder_days/);
    // The database still holds the ceiling itself (0167's CHECK), so a writer
    // that bypasses the service is refused as well.
    await expect(
      db.query(`UPDATE workspace_contracts SET reminder_days = 400 WHERE id = $1`, [atCeiling.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
