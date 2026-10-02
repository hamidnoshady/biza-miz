/**
 * Phase G — the workspace's pure rules.
 *
 * Everything asserted here is a decision that would otherwise be re-derived in
 * three places (a service, an API route, a component) and drift: the role
 * hierarchy, the deadline buckets, the dependency-cycle guard, the tag
 * normaliser and the template expansion. None of it needs a database, which is
 * exactly why it lives in `workspace-shared.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TEMPLATES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  WORKSPACE_ROLES,
  WORKSPACE_ROLE_LABELS,
  WORKSPACE_SECTIONS,
  WORKSPACE_SECTION_LABELS,
  addDays,
  approvalDecisionError,
  builtinTemplate,
  compareTasksForList,
  completionPercent,
  contractNeedsReminder,
  effectiveProjectRole,
  intervalOrdered,
  projectCapabilities,
  workspaceAccessFlags,
  daysUntil,
  deadlineTone,
  dependencyBlocksStatus,
  projectHealth,
  weekStartSaturday,
  dependenciesSatisfied,
  isWorkspaceSection,
  normalizeTags,
  phasesFromTemplate,
  roleAtLeast,
  roleCan,
  wouldCreateDependencyCycle,
} from "./workspace-shared";

describe("sections", () => {
  it("labels every section — a missing label would render a bare key in the rail", () => {
    for (const section of WORKSPACE_SECTIONS) {
      expect(WORKSPACE_SECTION_LABELS[section], section).toBeTruthy();
    }
    expect(WORKSPACE_SECTIONS).toHaveLength(10);
  });

  it("recognises its own keys and nothing else", () => {
    expect(isWorkspaceSection("contracts")).toBe(true);
    expect(isWorkspaceSection("payroll")).toBe(false);
  });
});

describe("vocabularies", () => {
  it("keeps the pre-Phase-G project statuses — widening must not drop a value", () => {
    // A value dropped here is a CHECK violation on somebody's existing row.
    for (const legacy of ["active", "paused", "completed"]) {
      expect(PROJECT_STATUSES).toContain(legacy);
    }
    expect(PROJECT_STATUSES).toContain("planning");
    expect(PROJECT_STATUSES).toContain("cancelled");
  });

  it("keeps the pre-Phase-G task statuses", () => {
    expect(TASK_STATUSES).toContain("open");
    expect(TASK_STATUSES).toContain("done");
    expect(TASK_STATUSES).toContain("in_progress");
    expect(TASK_STATUSES).toContain("blocked");
  });

  it("labels every value in every vocabulary", () => {
    for (const s of PROJECT_STATUSES) expect(PROJECT_STATUS_LABELS[s], s).toBeTruthy();
    for (const s of TASK_STATUSES) expect(TASK_STATUS_LABELS[s], s).toBeTruthy();
    for (const p of PRIORITIES) expect(PRIORITY_LABELS[p], p).toBeTruthy();
    for (const r of WORKSPACE_ROLES) expect(WORKSPACE_ROLE_LABELS[r], r).toBeTruthy();
    for (const t of CONTRACT_TYPES) expect(CONTRACT_TYPE_LABELS[t], t).toBeTruthy();
    expect(Object.keys(CONTRACT_STATUS_LABELS).length).toBeGreaterThan(0);
  });

  it("holds only EXECUTION contract types — relationship contracts are the CRM's", () => {
    // The split is the brief's central architectural request: a sales or
    // partnership agreement belongs on the customer file, not on a project.
    expect(CONTRACT_TYPES).toContain("contractor");
    expect(CONTRACT_TYPES).toContain("subcontractor");
    expect(CONTRACT_TYPES).not.toContain("sales");
    expect(CONTRACT_TYPES).not.toContain("partnership");
  });
});

describe("project roles", () => {
  it("orders the five roles from most to least capable", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("editor", "contributor")).toBe(true);
    expect(roleAtLeast("contributor", "editor")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("gives each capability to exactly the roles that should hold it", () => {
    expect(roleCan("viewer", "view")).toBe(true);
    expect(roleCan("viewer", "contribute")).toBe(false);
    expect(roleCan("contributor", "contribute")).toBe(true);
    expect(roleCan("contributor", "edit")).toBe(false);
    expect(roleCan("editor", "edit")).toBe(true);
    expect(roleCan("editor", "manage")).toBe(false);
    expect(roleCan("manager", "manage")).toBe(true);
    // Only the project owner may delete it — a manager who could destroy a
    // project they were merely added to is one misclick from an outage.
    expect(roleCan("manager", "administer")).toBe(false);
    expect(roleCan("owner", "administer")).toBe(true);
  });
});

describe("dates", () => {
  it("counts whole days and goes negative when overdue", () => {
    expect(daysUntil("2026-03-21", "2026-03-21")).toBe(0);
    expect(daysUntil("2026-03-28", "2026-03-21")).toBe(7);
    expect(daysUntil("2026-03-20", "2026-03-21")).toBe(-1);
  });

  it("buckets a deadline the same way everywhere", () => {
    expect(deadlineTone(null, "2026-03-21")).toBe("none");
    expect(deadlineTone("2026-03-19", "2026-03-21")).toBe("overdue");
    expect(deadlineTone("2026-03-21", "2026-03-21")).toBe("today");
    expect(deadlineTone("2026-03-25", "2026-03-21")).toBe("soon");
    expect(deadlineTone("2026-05-01", "2026-03-21")).toBe("later");
  });

  it("adds days across a month boundary", () => {
    expect(addDays("2026-03-30", 5)).toBe("2026-04-04");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("contract reminders", () => {
  const base = { status: "active" };

  it("stays quiet for a contract with no expiry", () => {
    expect(contractNeedsReminder({ ...base, endDate: null, reminderDays: 30 }, "2026-03-21")).toBe(false);
  });

  it("fires inside the business's own lead time", () => {
    expect(contractNeedsReminder({ ...base, endDate: "2026-04-01", reminderDays: 30 }, "2026-03-21")).toBe(true);
    expect(contractNeedsReminder({ ...base, endDate: "2026-06-01", reminderDays: 30 }, "2026-03-21")).toBe(false);
  });

  it("falls back to the default lead time when none is set", () => {
    expect(contractNeedsReminder({ ...base, endDate: "2026-04-01", reminderDays: null }, "2026-03-21")).toBe(true);
  });

  it("says nothing about a contract that is already over", () => {
    expect(contractNeedsReminder({ status: "completed", endDate: "2026-03-22", reminderDays: 30 }, "2026-03-21")).toBe(false);
    expect(contractNeedsReminder({ status: "terminated", endDate: "2026-03-22", reminderDays: 30 }, "2026-03-21")).toBe(false);
  });
});

describe("completion", () => {
  it("is 0 for a project with no tasks rather than NaN", () => {
    expect(completionPercent(0, 0)).toBe(0);
  });

  it("rounds to a whole percent", () => {
    expect(completionPercent(1, 3)).toBe(33);
    expect(completionPercent(3, 3)).toBe(100);
  });
});

describe("tags", () => {
  it("trims, de-duplicates and drops blanks", () => {
    expect(normalizeTags([" ویلا ", "ویلا", "", "  ", "تهران"])).toEqual(["ویلا", "تهران"]);
  });

  it("ignores non-arrays and non-strings rather than throwing", () => {
    expect(normalizeTags("nope")).toEqual([]);
    expect(normalizeTags([1, null, "ok"])).toEqual(["ok"]);
  });

  it("caps the count so a paste cannot blow up the row", () => {
    expect(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(12);
  });
});

describe("task dependencies", () => {
  it("refuses a self-dependency", () => {
    expect(wouldCreateDependencyCycle([], "a", "a")).toBe(true);
  });

  it("allows an ordinary edge", () => {
    expect(wouldCreateDependencyCycle([], "a", "b")).toBe(false);
  });

  it("catches the multi-hop cycle the DB CHECK cannot see", () => {
    // b waits on c, c waits on a. Adding "a waits on b" closes a→b→c→a.
    const edges = [
      { taskId: "b", dependsOnId: "c" },
      { taskId: "c", dependsOnId: "a" },
    ];
    expect(wouldCreateDependencyCycle(edges, "a", "b")).toBe(true);
  });

  it("does not mistake a diamond for a cycle", () => {
    const edges = [
      { taskId: "b", dependsOnId: "d" },
      { taskId: "c", dependsOnId: "d" },
    ];
    expect(wouldCreateDependencyCycle(edges, "a", "b")).toBe(false);
  });

  it("knows when a task is startable", () => {
    expect(dependenciesSatisfied([])).toBe(true);
    expect(dependenciesSatisfied(["done", "done"])).toBe(true);
    expect(dependenciesSatisfied(["done", "open"])).toBe(false);
  });
});

describe("task ordering", () => {
  const task = (
    priority: "low" | "normal" | "high" | "urgent",
    dueDate: string | null,
    title = "t",
  ) => ({ priority, dueDate, title });

  it("puts urgent before high before normal", () => {
    expect(compareTasksForList(task("urgent", null), task("high", null))).toBeLessThan(0);
    expect(compareTasksForList(task("normal", null), task("low", null))).toBeLessThan(0);
  });

  it("sorts equal priorities by due date, undated last", () => {
    expect(compareTasksForList(task("normal", "2026-03-01"), task("normal", "2026-04-01"))).toBeLessThan(0);
    expect(compareTasksForList(task("normal", null), task("normal", "2026-04-01"))).toBeGreaterThan(0);
  });

  it("is stable on title when everything else ties", () => {
    expect(compareTasksForList(task("normal", null, "الف"), task("normal", null, "ب"))).toBeLessThan(0);
  });
});

describe("templates", () => {
  it("ships blueprints for businesses that are not restaurants", () => {
    const keys = BUILTIN_TEMPLATES.map((t) => t.key);
    for (const expected of ["construction", "architecture", "software", "marketing"]) {
      expect(keys, expected).toContain(expected);
    }
    expect(keys).toContain("generic");
  });

  it("gives every built-in a unique key, a name and at least one phase", () => {
    const keys = new Set<string>();
    for (const template of BUILTIN_TEMPLATES) {
      expect(keys.has(template.key), template.key).toBe(false);
      keys.add(template.key);
      expect(template.name).toBeTruthy();
      expect(template.phases.length).toBeGreaterThan(0);
      for (const phase of template.phases) expect(phase.name).toBeTruthy();
    }
  });

  it("looks a template up by key", () => {
    expect(builtinTemplate("construction")?.name).toBe("ساخت‌وساز");
    expect(builtinTemplate("nope")).toBeNull();
  });

  it("expands into ordered phases, undated when the project has no start", () => {
    const template = builtinTemplate("software");
    expect(template).not.toBeNull();
    const phases = phasesFromTemplate(template!, null);
    expect(phases).toHaveLength(template!.phases.length);
    expect(phases.map((p) => p.displayOrder)).toEqual(phases.map((_, i) => i));
    // A template must be applicable to a project whose dates are unknown.
    for (const phase of phases) {
      expect(phase.startDate).toBeNull();
      expect(phase.endDate).toBeNull();
    }
  });

  it("dates the phases that declare a duration", () => {
    const phases = phasesFromTemplate(
      {
        key: "k", name: "n", description: "", projectType: "general",
        phases: [
          { name: "الف", durationDays: 10 },
          { name: "ب", durationDays: 5 },
        ],
        defaultTasks: [],
      },
      "2026-03-01",
    );
    expect(phases[0].startDate).toBe("2026-03-01");
    expect(phases[0].endDate).toBe("2026-03-11");
    // The second phase begins where the first ended — the cursor carries.
    expect(phases[1].startDate).toBe("2026-03-11");
    expect(phases[1].endDate).toBe("2026-03-16");
  });
});

/* ---------------------------------------------------------------------------
 * #761 — the access model's pure half
 * ------------------------------------------------------------------------- */

describe("workspaceAccessFlags", () => {
  it("never treats workspace.view or workspace.manage as an override", () => {
    expect(workspaceAccessFlags(new Set(["workspace.view", "workspace.manage"])).override).toBeNull();
  });
  it("gives workspace.admin the administer override and ledger.view the read one", () => {
    expect(workspaceAccessFlags(new Set(["workspace.admin"])).override).toBe("administer");
    expect(workspaceAccessFlags(new Set(["ledger.view"])).override).toBe("read");
    expect(workspaceAccessFlags(new Set(["ledger.view"])).canViewFinancials).toBe(true);
    expect(workspaceAccessFlags(new Set()).canViewFinancials).toBe(false);
  });
});

describe("effectiveProjectRole", () => {
  it("takes the stronger of membership and override, and null with neither", () => {
    expect(effectiveProjectRole(null, null)).toBeNull();
    expect(effectiveProjectRole("viewer", "administer")).toBe("manager");
    expect(effectiveProjectRole("owner", "administer")).toBe("owner");
    expect(effectiveProjectRole(null, "read")).toBe("viewer");
    expect(effectiveProjectRole("editor", "read")).toBe("editor");
  });
});

describe("projectCapabilities", () => {
  const flags = (perms: string[]) => workspaceAccessFlags(new Set(perms));
  it("intersects the project role with the platform permission", () => {
    // An editor on the project without workspace.manage still cannot write.
    const caps = projectCapabilities("editor", flags(["workspace.view"]));
    expect(caps.canView).toBe(true);
    expect(caps.canEdit).toBe(false);
    expect(projectCapabilities("editor", flags(["workspace.manage"])).canEdit).toBe(true);
    expect(projectCapabilities("viewer", flags(["workspace.manage"])).canEdit).toBe(false);
    expect(projectCapabilities(null, flags(["workspace.manage"])).canView).toBe(false);
  });
  it("shows spend only to a ledger reader", () => {
    expect(projectCapabilities("owner", flags(["workspace.manage"])).canViewFinancials).toBe(false);
    expect(projectCapabilities("viewer", flags(["ledger.view"])).canViewFinancials).toBe(true);
  });
});

describe("approvalDecisionError", () => {
  const base = {
    actorUserId: "me", requestedBy: "them", approverUserId: null,
    isAdministrator: false, canManageSubject: false,
  } as const;
  it("forbids deciding your own request, even as administrator", () => {
    expect(approvalDecisionError({ ...base, decision: "approved", requestedBy: "me", isAdministrator: true }))
      .toBe("self_approval_forbidden");
  });
  it("reserves a named request for its approver or an administrator", () => {
    expect(approvalDecisionError({ ...base, decision: "approved", approverUserId: "x", canManageSubject: true }))
      .toBe("not_the_approver");
    expect(approvalDecisionError({ ...base, decision: "rejected", approverUserId: "me" })).toBeNull();
    expect(approvalDecisionError({ ...base, decision: "changes_requested", approverUserId: "x", isAdministrator: true }))
      .toBeNull();
  });
  it("lets a project manager decide an unassigned request", () => {
    expect(approvalDecisionError({ ...base, decision: "approved" })).toBe("insufficient_project_role");
    expect(approvalDecisionError({ ...base, decision: "approved", canManageSubject: true })).toBeNull();
  });
  it("lets only the requester (or an administrator) withdraw", () => {
    expect(approvalDecisionError({ ...base, decision: "cancelled" })).toBe("not_the_requester");
    expect(approvalDecisionError({ ...base, decision: "cancelled", requestedBy: "me" })).toBeNull();
  });
});

describe("intervalOrdered", () => {
  it("accepts open ends and equal bounds, refuses a reversed interval", () => {
    expect(intervalOrdered(null, "2026-01-01")).toBe(true);
    expect(intervalOrdered("2026-01-01", "2026-01-01")).toBe(true);
    expect(intervalOrdered("2026-02-01", "2026-01-01")).toBe(false);
    expect(intervalOrdered("10:00", "09:30")).toBe(false);
  });
});

describe("projectHealth", () => {
  const base = {
    today: "2026-06-01", startDate: "2026-01-01", endDate: "2026-12-31", completed: false,
    taskCount: 10, doneTaskCount: 5, overdueTaskCount: 0, budgetRial: 1000, spentRial: 100,
    pendingApprovals: 0, expiringContracts: 0,
  };
  it("is on track when progress keeps pace with time", () => {
    expect(projectHealth(base)).toMatchObject({ health: "on_track", reasons: [] });
  });
  it("flags trailing progress as at risk, then off track", () => {
    expect(projectHealth({ ...base, doneTaskCount: 3 }).health).toBe("at_risk");
    expect(projectHealth({ ...base, doneTaskCount: 1 })).toMatchObject({
      health: "off_track", reasons: ["behind_schedule"],
    });
  });
  it("puts severe reasons first and never judges budget without the ledger", () => {
    const r = projectHealth({ ...base, spentRial: 1200, overdueTaskCount: 2 });
    expect(r.health).toBe("off_track");
    expect(r.reasons).toEqual(["over_budget", "overdue_tasks"]);
    expect(projectHealth({ ...base, spentRial: null }).reasons).not.toContain("over_budget");
    expect(projectHealth({ ...base, spentRial: 950 }).reasons).toContain("budget_nearly_spent");
  });
  it("treats a passed deadline with open work as off track, and a completed project as fine", () => {
    expect(projectHealth({ ...base, today: "2027-01-05" }).reasons).toContain("past_deadline");
    expect(projectHealth({ ...base, today: "2027-01-05", completed: true }).health).toBe("on_track");
  });
  it("does not judge schedule before the start date", () => {
    expect(projectHealth({ ...base, today: "2025-12-01", doneTaskCount: 0 }).reasons).toEqual([]);
  });
});

describe("dependencyBlocksStatus", () => {
  it("refuses done with open blockers, allows everything else", () => {
    expect(dependencyBlocksStatus("done", 1)).toBe(true);
    expect(dependencyBlocksStatus("done", 0)).toBe(false);
    expect(dependencyBlocksStatus("in_progress", 3)).toBe(false);
  });
});

describe("weekStartSaturday", () => {
  it("snaps any day to the Saturday that opens its Persian week", () => {
    expect(weekStartSaturday("2026-10-03")).toBe("2026-10-03"); // a Saturday
    expect(weekStartSaturday("2026-10-09")).toBe("2026-10-03"); // the Friday after
    expect(weekStartSaturday("2026-10-02")).toBe("2026-09-26"); // the Friday before
  });
});
