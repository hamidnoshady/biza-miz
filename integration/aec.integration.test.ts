/**
 * Issue #799 Wave 2 — the AEC operating profile, the project's AEC profile and
 * its external participants, against a real PostgreSQL.
 *
 * The unit tests in `src/lib/aec.test.ts` prove the catalogue and the preset
 * arithmetic. What can only be proven here is what the database refuses:
 *
 *   * the three new tables carry forced RLS with a policy, so the schema sweep
 *     in `tenant-isolation.integration.test.ts` will find nothing missing;
 *   * a project profile cannot name another business's project (the composite
 *     foreign key) or another business's party/user (the migration's trigger) —
 *     including when the service layer is bypassed entirely;
 *   * the service refuses AEC configuration for a non-AEC business, and a
 *     participant role the operating profile does not allow;
 *   * recording an external participant creates no user and no membership —
 *     §6's "external parties must not gain business-wide access";
 *   * `capability_overrides` stores *deltas only*, so a value that merely
 *     restates the profile's preset is not frozen into the row.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { AecError } from "../src/lib/aec-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let aec: typeof import("../src/lib/aec-service");
let widgets: typeof import("../src/lib/ai-widgets");
let tools: typeof import("../src/lib/aec-ai-tools");
let workspace: typeof import("../src/lib/workspace");

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
  databaseName = `pos_aec_${randomUUID().replaceAll("-", "")}`;

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
  aec = await import("../src/lib/aec-service");
  widgets = await import("../src/lib/ai-widgets");
  tools = await import("../src/lib/aec-ai-tools");
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

let seq = 0;

/** A provisioned business of the given industry, with its owner as the actor. */
async function provisionBusiness(industry: "architecture_construction" | "food_service") {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار ${industry} ${seq}`,
    ownerName: "مالک",
    email: `owner-${industry}-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `aec${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    owner: { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" },
  };
}

/** One party of this business, created the way the CRM would create it. */
async function createParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, $2, 'supplier') RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/** A project owned by the given business — the shape `/api/workspace/projects` writes. */
async function createProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    // `created_by` is text (the pre-Phase-G write path) while `owner_user_id`
    // is a uuid, so the same value needs a cast for each — without them
    // PostgreSQL cannot deduce one type for the parameter.
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

/** One open task with a due date — the shape `/api/workspace/tasks` writes. */
async function createTask(
  businessId: string,
  projectId: string,
  title: string,
  dueDate: string,
  actorUserId: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    // `created_by` is NOT NULL on this table, like `ai_projects.created_by`.
    `INSERT INTO ai_project_tasks (project_id, title, status, priority, due_date, created_by)
     VALUES ($1, $2, 'open', 'normal', $3, $4) RETURNING id`,
    [projectId, title, dueDate, actorUserId],
  );
  return rows[0].id;
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

describe("the AEC assistant read tools (issue #799 §23)", () => {
  it("reports a project's commercial position from the ledger and the AEC profile", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "برج نیلوفر");
    await dbLib.withTenant(businessId, async () => {
      await aec.saveProjectAecProfile(owner, projectId, {
        projectNumber: "A-1404-07",
        employerPartyId: await createParty(businessId, "کارفرمای نیلوفر"),
        plannedPhysicalProgress: 60,
        reportedPhysicalProgress: 42.5,
      });
      await createTask(businessId, projectId, "نصب اسکلت طبقهٔ سوم", "2026-01-15", owner.actorUserId);

      const result = await tools.runAecReadTool(
        "get_aec_project_financial_health",
        { projectName: "برج نیلوفر" },
        businessId,
        "architecture_construction",
      );
      expect(result.ok).toBe(true);
      const data = result.data as {
        name: string;
        aec: { recorded: boolean; projectNumber: string | null; reportedPhysicalProgress: string | null };
        overdueTaskCount: number;
        today: string;
      };
      expect(data.name).toBe("برج نیلوفر");
      expect(data.aec.recorded).toBe(true);
      expect(data.aec.projectNumber).toBe("A-1404-07");
      expect(data.aec.reportedPhysicalProgress).toBe("42.50");
      // The task was due in the past relative to the business day the tool
      // reports, so the delay count is real rather than incidental.
      expect(data.today > "2026-01-15").toBe(true);
      expect(data.overdueTaskCount).toBe(1);
    });
  });

  it("lists what is late, and asks which project when the name is ambiguous", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const first = await createProject(businessId, owner.actorUserId, "ساختمان اداری");
    const second = await createProject(businessId, owner.actorUserId, "ساختمان اداری");
    await dbLib.withTenant(businessId, async () => {
      await createTask(businessId, first, "تأیید نقشهٔ سازه", "2026-02-01", owner.actorUserId);
      await createTask(businessId, second, "تحویل نمونهٔ نما", "2026-03-01", owner.actorUserId);

      const all = await tools.runAecReadTool(
        "list_delayed_project_activities",
        {},
        businessId,
        "architecture_construction",
      );
      expect(all.ok).toBe(true);
      const data = all.data as { delayedTaskCount: number; tasks: Array<{ daysLate: number | null }> };
      expect(data.delayedTaskCount).toBeGreaterThanOrEqual(2);
      expect(data.tasks[0].daysLate).toBeGreaterThan(0);

      const ambiguous = await tools.runAecReadTool(
        "list_delayed_project_activities",
        { projectName: "ساختمان اداری" },
        businessId,
        "architecture_construction",
      );
      expect(ambiguous.ok).toBe(true);
      const body = ambiguous.data as { ambiguous?: boolean; candidates?: unknown[] };
      expect(body.ambiguous).toBe(true);
      expect(body.candidates?.length).toBe(2);
    });
  });
});

describe("the AEC workspace overview roll-up (issue #799 §3)", () => {
  it("counts the risk and the money for a construction business only", async () => {
    const aecTenant = await provisionBusiness("architecture_construction");
    const cafe = await provisionBusiness("food_service");

    const projectId = await createProject(aecTenant.businessId, aecTenant.owner.actorUserId, "مجتمع تجاری آفتاب");
    await db.query(
      `UPDATE ai_projects SET budget_rial = 5000000000 WHERE id = $1`,
      [projectId],
    );
    await dbLib.withTenant(aecTenant.businessId, async () => {
      await createTask(aecTenant.businessId, projectId, "تسویه با پیمانکار نما", "2026-01-20", aecTenant.owner.actorUserId);

      const dashboard = await workspace.getWorkspaceDashboard(
        aecTenant.businessId,
        aecTenant.owner.actorUserId,
      );
      const rollup = dashboard.aec;
      expect(rollup).toBeTruthy();
      expect(rollup?.projectsAtRisk).toBe(1);
      expect(rollup?.lateMilestoneCount).toBeGreaterThanOrEqual(1);
      expect(rollup?.budgetRial).toBe(5_000_000_000);
      // A managed task with no ledger posting is late but not a cost, so the
      // roll-up reports the budget it can see and no invented spend.
      expect(rollup?.spentRial).toBe(0);
      expect(rollup?.overBudgetProjectCount).toBe(0);

      // The same call for a café answers the overview it always had.
      await dbLib.withTenant(cafe.businessId, async () => {
        const cafeDashboard = await workspace.getWorkspaceDashboard(
          cafe.businessId,
          cafe.owner.actorUserId,
        );
        expect(cafeDashboard.aec).toBeUndefined();
      });
    });
  });
});

describe("every AEC table is tenant-isolated", () => {
  it("has RLS enabled, forced, and one policy each", async () => {
    const { rows } = await db.query<{
      relname: string;
      secured: boolean;
      policies: string;
    }>(
      `SELECT c.relname, (c.relrowsecurity AND c.relforcerowsecurity) AS secured,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r' AND c.relname LIKE 'aec\\_%' ESCAPE '\\'
        ORDER BY c.relname`,
    );
    // Listed literally rather than counted: a table added without its policy is
    // exactly the mistake this guard exists for. Wave 4's five arrive from
    // migration 0196; `integration/aec-boq.integration.test.ts` owns their
    // behaviour.
    expect(rows.map((r) => r.relname)).toEqual([
      "aec_boq_items",
      "aec_boq_sections",
      "aec_business_profiles",
      "aec_estimate_events",
      "aec_estimate_versions",
      "aec_estimates",
      "aec_project_participants",
      "aec_project_profiles",
    ]);
    for (const row of rows) {
      expect(row.secured, row.relname).toBe(true);
      expect(Number(row.policies), row.relname).toBe(1);
    }
  });
});

describe("the business's operating profile", () => {
  it("serves the default preset until a profile has been saved", async () => {
    const { businessId } = await provisionBusiness("architecture_construction");
    const state = await dbLib.withTenant(businessId, () => aec.loadBusinessAecProfile(businessId));

    expect(state.stored).toBe(false);
    expect(state.operatingProfile).toBe("architecture_office");
    expect(state.capabilities).toContain("design_phases");
    expect(state.capabilities).not.toContain("site_operations");
    // The default profile therefore cannot record a foreman — the presets do
    // real work before the business has even opened the settings screen.
    expect(state.participantRoles).not.toContain("foreman");
    expect(state.participantRoles).toContain("architect");
  });

  it("stores a contractor profile with its specialties and only real overrides", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const saved = await dbLib.withTenant(businessId, () =>
      aec.saveBusinessAecProfile(owner, {
        operatingProfile: "contractor",
        // 'welding' is not in the catalogue: dropped, not rejected.
        specialties: ["architecture", "mep", "welding", " architecture "],
        // site_operations is already in the contractor preset (not an override);
        // subcontractors is, and turning it off is.
        capabilityOverrides: { site_operations: true, subcontractors: false, nonsense: true },
      }),
    );

    expect(saved.stored).toBe(true);
    expect(saved.operatingProfile).toBe("contractor");
    expect(saved.specialties).toEqual(["architecture", "mep"]);
    expect(saved.capabilities).toContain("site_operations");
    expect(saved.capabilities).not.toContain("subcontractors");
    expect(saved.participantRoles).toContain("foreman");
    expect(saved.participantRoles).not.toContain("subcontractor");

    // Deltas only: the preset's own value was not written back into the row.
    const { rows } = await db.query<{ capability_overrides: Record<string, boolean> }>(
      "SELECT capability_overrides FROM aec_business_profiles WHERE business_id = $1",
      [businessId],
    );
    expect(rows[0].capability_overrides).toEqual({ subcontractors: false });

    // And a re-read resolves to the same answer.
    const reread = await dbLib.withTenant(businessId, () => aec.loadBusinessAecProfile(businessId));
    expect(reread.capabilities).toEqual(saved.capabilities);
    expect(reread.specialties).toEqual(saved.specialties);
  });

  it("refuses an unknown operating profile", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    await dbLib.withTenant(businessId, async () => {
      await expect(
        aec.saveBusinessAecProfile(owner, { operatingProfile: "welder" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_operating_profile");
        return true;
      });
    });
  });

  it("refuses the whole AEC area to a business of another industry", async () => {
    const { businessId, owner } = await provisionBusiness("food_service");
    await dbLib.withTenant(businessId, async () => {
      await expect(aec.loadBusinessAecProfile(businessId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
      await expect(
        aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });
  });

  it("answers the cockpit question for every industry, refusing nobody", async () => {
    const { businessId } = await provisionBusiness("architecture_construction");
    const aecCockpit = await dbLib.withTenant(businessId, () =>
      aec.loadAecProjectCockpit(businessId),
    );
    expect(aecCockpit.aec).toBe(true);
    // The default preset's live capabilities — what the project page's
    // capability-aware tabs are computed from (#799 §21).
    expect(aecCockpit.capabilities).toContain("projects");
    expect(aecCockpit.capabilities).toContain("participants");
    expect(aecCockpit.capabilities).not.toContain("boq");

    // A café is answered, not refused: its project page calls the same read
    // and must show the ordinary workspace rather than an error.
    const { businessId: cafeId } = await provisionBusiness("food_service");
    const cafeCockpit = await dbLib.withTenant(cafeId, () => aec.loadAecProjectCockpit(cafeId));
    expect(cafeCockpit).toEqual({ aec: false, capabilities: [] });
  });

  it("offers the picker's role list to AEC only, and only the allowed roles", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    await dbLib.withTenant(businessId, async () => {
      const options = await aec.listAecParticipantRoleOptions(businessId);
      expect(options).not.toBeNull();
      // Grouped the way the picker renders them: the client's side first, then
      // the design side, then contractors, then site staff.
      expect(options!.map((o) => o.group).slice(0, 2)).toEqual(["client", "client"]);
      const architect = options!.find((o) => o.key === "architect");
      expect(architect).toEqual({ key: "architect", label: "معمار", group: "consultant" });
      // The default architecture-office preset allows no foreman — the picker
      // list and the service's refusal answer from the same resolution.
      expect(options!.some((o) => o.key === "foreman")).toBe(false);
      // No field role survives the architecture-office preset, so the last
      // group is the contracting side's one always-available role.
      expect(options!.at(-1)!.group).toBe("contractor");
    });

    const { businessId: cafeId } = await provisionBusiness("food_service");
    const cafeOptions = await dbLib.withTenant(cafeId, () =>
      aec.listAecParticipantRoleOptions(cafeId),
    );
    expect(cafeOptions).toBeNull();
  });
});

describe("the AEC widget recommendations", () => {
  it("offers the industry's widgets to an AEC tenant and not to a café", async () => {
    const permissions = new Set([
      "workspace.view",
      "workspace.approve",
    ]) as Parameters<typeof widgets.listRecommendedAiWidgets>[1];

    const { businessId: aecBusiness } = await provisionBusiness("architecture_construction");
    const aecRecommended = await dbLib.withTenant(aecBusiness, () =>
      widgets.listRecommendedAiWidgets("architecture_construction", permissions),
    );
    const names = aecRecommended.map((widget) => widget.name);
    expect(names).toContain("پروژه‌های در معرض خطر");
    expect(names).toContain("تأییدهای در انتظار");
    expect(names).toContain("قراردادهای نزدیک به پایان");
    // The AEC rows are the platform's, not one tenant's: `business_id IS NULL`.
    for (const widget of aecRecommended.filter((w) => w.industry === "architecture_construction")) {
      expect(widget.requiredPermissions.every((key) => permissions.has(key))).toBe(true);
    }

    // A café sees its own pair — never another industry's.
    const { businessId: cafeBusiness } = await provisionBusiness("food_service");
    const cafeRecommended = await dbLib.withTenant(cafeBusiness, () =>
      widgets.listRecommendedAiWidgets("food_service", permissions),
    );
    expect(cafeRecommended.some((w) => w.industry === "architecture_construction")).toBe(false);
  });

  it("withholds a widget whose permission the caller lacks", async () => {
    const withoutApprove = new Set(["workspace.view"]) as Parameters<
      typeof widgets.listRecommendedAiWidgets
    >[1];
    const { businessId } = await provisionBusiness("architecture_construction");
    const recommended = await dbLib.withTenant(businessId, () =>
      widgets.listRecommendedAiWidgets("architecture_construction", withoutApprove),
    );
    expect(recommended.some((w) => w.name === "تأییدهای در انتظار")).toBe(false);
    expect(recommended.some((w) => w.name === "پروژه‌های در معرض خطر")).toBe(true);
  });
});

describe("a project's AEC profile", () => {
  it("creates the row on first save and returns every field mapped", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "برج A");
    const employerPartyId = await createParty(businessId, "کارفرمای الف");

    const saved = await dbLib.withTenant(businessId, () =>
      aec.saveProjectAecProfile(owner, projectId, {
        projectNumber: "۱۴۰۳-۱۲",
        projectCategory: "تجاری",
        siteName: "زمین شماره ۱۲",
        address: "تهران، خیابان اول",
        city: "تهران",
        region: "منطقه ۱",
        latitude: "35.6892",
        longitude: "-51.3890",
        landArea: "1200",
        builtArea: "4800.5",
        floorCount: "12",
        employerPartyId,
        leadConsultantPartyId: employerPartyId,
        mainContractorPartyId: employerPartyId,
        projectManagerUserId: owner.actorUserId,
        contractMethod: "مقطوع",
        deliveryMethod: "طراحی-ساخت",
        permitNumbers: ["۱۲۳/ش", "۴۵۶"],
        plannedStartDate: "2026-01-01",
        plannedEndDate: "2026-12-31",
        actualStartDate: "2026-02-01",
        plannedPhysicalProgress: "25",
        reportedPhysicalProgress: "20.5",
        notes: "پروژه با کارفرمای خصوصی.",
      }),
    );

    expect(saved.projectId).toBe(projectId);
    expect(saved.projectNumber).toBe("۱۴۰۳-۱۲");
    expect(saved.latitude).toBe("35.689200");
    expect(saved.longitude).toBe("-51.389000");
    expect(saved.landArea).toBe("1200.00");
    expect(saved.builtArea).toBe("4800.50");
    expect(saved.floorCount).toBe(12);
    expect(saved.employerPartyName).toBe("کارفرمای الف");
    expect(saved.projectManagerName).toBe("مالک");
    expect(saved.permitNumbers).toEqual(["۱۲۳/ش", "۴۵۶"]);
    expect(saved.plannedStartDate).toBe("2026-01-01");
    expect(saved.plannedPhysicalProgress).toBe("25.00");
    expect(saved.reportedPhysicalProgress).toBe("20.50");

    // A patch changes only what it names; everything else survives.
    const patched = await dbLib.withTenant(businessId, () =>
      aec.saveProjectAecProfile(owner, projectId, { reportedPhysicalProgress: "41" }, { partial: true }),
    );
    expect(patched.reportedPhysicalProgress).toBe("41.00");
    expect(patched.projectNumber).toBe("۱۴۰۳-۱۲");
    expect(patched.plannedPhysicalProgress).toBe("25.00");
  });

  it("returns null for a project that has no profile yet", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "بدون پروفایل");
    const profile = await dbLib.withTenant(businessId, () =>
      aec.loadProjectAecProfile(businessId, projectId),
    );
    expect(profile).toBeNull();
  });

  it("refuses dates that run backwards", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "تاریخ معکوس");
    await dbLib.withTenant(businessId, async () => {
      await expect(
        aec.saveProjectAecProfile(owner, projectId, {
          plannedStartDate: "2026-06-01",
          plannedEndDate: "2026-01-01",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "end_before_start");
        return true;
      });
    });
  });

  it("refuses another business's party, and the database refuses it too", async () => {
    const alpha = await provisionBusiness("architecture_construction");
    const beta = await provisionBusiness("architecture_construction");
    const projectId = await createProject(alpha.businessId, alpha.owner.actorUserId, "پروژه آلفا");
    const foreignPartyId = await createParty(beta.businessId, "طرف بتا");

    await dbLib.withTenant(alpha.businessId, async () => {
      await expect(
        aec.saveProjectAecProfile(alpha.owner, projectId, { employerPartyId: foreignPartyId }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
    });

    // Bypassing the service entirely: the migration's trigger is the backstop.
    await expect(
      db.query(
        `INSERT INTO aec_project_profiles (business_id, project_id, employer_party_id)
         VALUES ($1, $2, $3)`,
        [alpha.businessId, projectId, foreignPartyId],
      ),
    ).rejects.toThrow(/must reference a record of the same business/);
  });

  it("cannot attach a project of another business, at the database level", async () => {
    const alpha = await provisionBusiness("architecture_construction");
    const beta = await provisionBusiness("architecture_construction");
    const projectId = await createProject(alpha.businessId, alpha.owner.actorUserId, "پروژه آلفا");
    await expect(
      db.query(`INSERT INTO aec_project_profiles (business_id, project_id) VALUES ($1, $2)`, [
        beta.businessId,
        projectId,
      ]),
    ).rejects.toThrow(/aec_project_profiles_business_id_project_id_fkey/);
  });
});

describe("external project participants", () => {
  it("gates the role on the operating profile, not merely on the picker", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژه نقش‌ها");
    const architect = await createParty(businessId, "دفتر معمار");
    const subcontractor = await createParty(businessId, "پیمانکار جزء");

    // The default profile is `architecture_office`: an architect is fine, a
    // subcontractor is not.
    await dbLib.withTenant(businessId, async () => {
      const added = await aec.addProjectParticipant(owner, projectId, {
        partyId: architect,
        role: "architect",
        contactName: "مهندس رضایی",
      });
      expect(added).toHaveLength(1);
      expect(added[0].partyName).toBe("دفتر معمار");
      expect(added[0].role).toBe("architect");

      await expect(
        aec.addProjectParticipant(owner, projectId, { partyId: subcontractor, role: "subcontractor" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "role_not_allowed");
        return true;
      });

      await expect(
        aec.addProjectParticipant(owner, projectId, { partyId: architect, role: "welder" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "role_not_allowed");
        return true;
      });
    });

    // Switch the business to a contractor profile: the same role is now allowed
    // and the existing participant list still answers.
    await dbLib.withTenant(businessId, async () => {
      await aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" });
      const participants = await aec.addProjectParticipant(owner, projectId, {
        partyId: subcontractor,
        role: "subcontractor",
      });
      expect(participants.map((p) => p.role).sort()).toEqual(["architect", "subcontractor"]);
    });
  });

  it("refuses a duplicate role for the same party, and a foreign party", async () => {
    const alpha = await provisionBusiness("architecture_construction");
    const beta = await provisionBusiness("architecture_construction");
    const projectId = await createProject(alpha.businessId, alpha.owner.actorUserId, "پروژه تکراری");
    const party = await createParty(alpha.businessId, "پیمانکار اصلی");
    const foreignParty = await createParty(beta.businessId, "طرف بتا");

    await dbLib.withTenant(alpha.businessId, async () => {
      await aec.addProjectParticipant(alpha.owner, projectId, { partyId: party, role: "contractor" });
      await expect(
        aec.addProjectParticipant(alpha.owner, projectId, { partyId: party, role: "contractor" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "participant_exists");
        return true;
      });
      await expect(
        aec.addProjectParticipant(alpha.owner, projectId, { partyId: foreignParty, role: "architect" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
    });
  });

  it("creates no user and no membership — a participant is a record, not a grant", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژه دسترسی");
    const party = await createParty(businessId, "مشاور بیرونی");

    const before = await dbLib.withTenant(businessId, () =>
      dbLib.query<{ users: string; members: string }>(
        `SELECT (SELECT count(*) FROM users WHERE business_id = $1) AS users,
                (SELECT count(*) FROM workspace_members m JOIN ai_projects p ON p.id = m.project_id
                  WHERE p.business_id = $1) AS members`,
        [businessId],
      ),
    );

    await dbLib.withTenant(businessId, () =>
      aec.addProjectParticipant(owner, projectId, { partyId: party, role: "architect" }),
    );

    const after = await dbLib.withTenant(businessId, () =>
      dbLib.query<{ users: string; members: string; employee_user: string | null }>(
        `SELECT (SELECT count(*) FROM users WHERE business_id = $1) AS users,
                (SELECT count(*) FROM workspace_members m JOIN ai_projects p ON p.id = m.project_id
                  WHERE p.business_id = $1) AS members,
                (SELECT employee_user_id::text FROM parties WHERE id = $2) AS employee_user`,
        [businessId, party],
      ),
    );

    expect(after.rows[0].users).toBe(before.rows[0].users);
    expect(after.rows[0].members).toBe(before.rows[0].members);
    // The party was never linked to a login either.
    expect(after.rows[0].employee_user).toBeNull();
  });

  it("updates the role, the contact and the window, then removes the row", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژه ویرایش");
    const party = await createParty(businessId, "نقشه‌بردار");
    await dbLib.withTenant(businessId, async () => {
      const [participant] = await aec.addProjectParticipant(owner, projectId, {
        partyId: party,
        role: "surveyor",
      });

      // `civil_engineer` rather than `inspector`: an architecture office may
      // record an engineer (no capability required) but not an inspector
      // (qa_qc/supervision required, neither of which its preset has).
      const updated = await aec.updateProjectParticipant(owner, projectId, participant.id, {
        role: "civil_engineer",
        contactName: "آقای احمدی",
        notes: "از طرف کارفرما",
        startedAt: "2026-03-01",
      });
      expect(updated[0].role).toBe("civil_engineer");
      expect(updated[0].contactName).toBe("آقای احمدی");
      expect(updated[0].startedAt).toBe("2026-03-01");

      // Backwards window refused.
      await expect(
        aec.updateProjectParticipant(owner, projectId, participant.id, {
          startedAt: "2026-06-01",
          endedAt: "2026-01-01",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "end_before_start");
        return true;
      });

      const removed = await aec.removeProjectParticipant(owner, projectId, participant.id);
      expect(removed).toEqual([]);

      await expect(
        aec.removeProjectParticipant(owner, projectId, participant.id),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "participant_not_found");
        return true;
      });
    });
  });
});
