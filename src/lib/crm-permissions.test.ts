/**
 * The CRM's authorization boundary, checked against the routes that enforce it.
 *
 * ## What went wrong without this file
 *
 * Two drifts, both invisible until somebody hit them:
 *
 *  1. the sidebar admitted a section on an **OR**-list while the section's own
 *     API required `crm.view`, so a member with `crm.export` but not `crm.view`
 *     opened Deals, the page rendered, and every request behind it answered 403
 *     — a screen that looks broken rather than a door that is shut;
 *  2. the case delete button was drawn on `crm.manage` while
 *     `DELETE /api/crm/cases/[id]` required `crm.delete` — a control whose
 *     request could only fail.
 *
 * Both are inequalities between what a screen admits and what its route
 * accepts. So this file reads every route under `src/app/api/crm/`, extracts the
 * permission each one guards with, and compares it with `CRM_SECTION_ACCESS` in
 * both directions:
 *
 *  - **whoever may open a section must pass its routes** (`route ⊆ section`),
 *    which is the first bug;
 *  - **whoever the table promises an action must not be refused by the route
 *    that performs it** (`section ⊆ route`), which is the second.
 *
 * Everything it models — reads, writes, the implication closure — comes from the
 * same functions the app runs, so the test cannot pass while a request fails.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Permission } from "./permissions";
import { PERMISSIONS, effectivePermissions, impliedPermissions } from "./permissions";
import {
  CRM_SECTION_ACCESS,
  CRM_SECTION_KEYS,
  canDeleteCrmSection,
  canMergeCrmSection,
  canOpenCrm,
  canViewCrmSection,
  canWriteCrmSection,
  crmSectionPermission,
  crmSectionRoutePermission,
  type CrmSectionAction,
  type CrmSectionKey,
} from "./crm-permissions";

const API_DIR = fileURLToPath(new URL("../app/api/crm", import.meta.url));

/** A route and the section action it belongs to. */
interface RouteAccess {
  /** Path relative to `src/app/api/crm/`, as the filesystem spells it. */
  route: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  section: CrmSectionKey;
  action: CrmSectionAction;
  /** Why this route is classified the way it is, when that is not obvious. */
  note?: string;
}

/**
 * Every route the CRM serves, and what it is *for*.
 *
 * Kept as an explicit list rather than inferred from the URL, because the point
 * of the exercise is that somebody had to decide — and a new route that nobody
 * classified fails the coverage check below.
 */
const ROUTES: RouteAccess[] = [
  { route: "activities/route.ts", method: "GET", section: "activities", action: "read" },
  { route: "activities/route.ts", method: "POST", section: "activities", action: "write" },
  { route: "activities/[id]/route.ts", method: "PATCH", section: "activities", action: "write" },
  {
    route: "activities/[id]/route.ts",
    method: "DELETE",
    section: "activities",
    action: "write",
    note: "Deleting a logged call is floor work, like writing one",
  },
  { route: "cases/route.ts", method: "GET", section: "cases", action: "read" },
  { route: "cases/route.ts", method: "POST", section: "cases", action: "write" },
  { route: "cases/[id]/route.ts", method: "GET", section: "cases", action: "read" },
  { route: "cases/[id]/route.ts", method: "DELETE", section: "cases", action: "delete" },
  {
    route: "cases/[id]/route.ts",
    method: "PATCH",
    section: "cases",
    action: "read",
    note: "Moving a ticket's status is the floor's own case surface — every key that opens the section already passes it",
  },
  { route: "consent/route.ts", method: "GET", section: "consent", action: "read" },
  { route: "customers/[id]/consent/route.ts", method: "GET", section: "consent", action: "read" },
  { route: "customers/[id]/consent/route.ts", method: "POST", section: "consent", action: "write" },
  { route: "customers/[id]/file/route.ts", method: "GET", section: "persons", action: "read" },
  { route: "customers/[id]/notes/route.ts", method: "GET", section: "persons", action: "read" },
  { route: "customers/[id]/notes/route.ts", method: "POST", section: "persons", action: "write" },
  { route: "customers/[id]/notes/route.ts", method: "PATCH", section: "persons", action: "write" },
  { route: "customers/[id]/notes/route.ts", method: "DELETE", section: "persons", action: "write" },
  { route: "customers/[id]/tags/route.ts", method: "PATCH", section: "persons", action: "write" },
  { route: "customers/[id]/relationships/route.ts", method: "GET", section: "persons", action: "read" },
  {
    route: "customers/[id]/relationships/route.ts",
    method: "POST",
    section: "persons",
    action: "write",
    note: "Declared as a `routes` refinement: the identity graph is management work",
  },
  {
    route: "customers/[id]/relationships/route.ts",
    method: "DELETE",
    section: "persons",
    action: "write",
    note: "Declared as a `routes` refinement: the identity graph is management work",
  },
  { route: "customers/[id]/timeline/route.ts", method: "GET", section: "persons", action: "read" },
  { route: "customers/duplicates/route.ts", method: "GET", section: "duplicates", action: "read" },
  { route: "customers/merge/route.ts", method: "GET", section: "duplicates", action: "read" },
  { route: "customers/merge/route.ts", method: "POST", section: "duplicates", action: "merge" },
  { route: "deals/route.ts", method: "GET", section: "deals", action: "read" },
  {
    route: "members/route.ts",
    method: "GET",
    section: "deals",
    action: "read",
    note: "The assignee picker. Its own read rather than /api/team, which needs a team key the pipeline does not",
  },
  { route: "deals/route.ts", method: "POST", section: "deals", action: "write" },
  { route: "deals/[id]/route.ts", method: "PATCH", section: "deals", action: "write" },
  {
    route: "deals/[id]/route.ts",
    method: "DELETE",
    section: "deals",
    action: "write",
    note: "A deal is a forecast; removing one is an edit, not the destruction of a legal record",
  },
  { route: "deals/[id]/handoff/route.ts", method: "GET", section: "deals", action: "write" },
  { route: "deals/[id]/handoff/route.ts", method: "POST", section: "deals", action: "write" },
  { route: "external-profiles/route.ts", method: "GET", section: "reconciliation", action: "read" },
  { route: "external-profiles/[id]/route.ts", method: "POST", section: "reconciliation", action: "write" },
  { route: "leads/route.ts", method: "GET", section: "leads", action: "read" },
  { route: "leads/route.ts", method: "POST", section: "leads", action: "write" },
  { route: "leads/[id]/convert/route.ts", method: "GET", section: "leads", action: "read" },
  { route: "leads/[id]/convert/route.ts", method: "POST", section: "leads", action: "write" },
  { route: "overview/route.ts", method: "GET", section: "overview", action: "read" },
  { route: "rfm/route.ts", method: "POST", section: "overview", action: "write" },
  { route: "segments/route.ts", method: "GET", section: "segments", action: "read" },
  { route: "segments/route.ts", method: "POST", section: "segments", action: "configure" },
  { route: "segments/[id]/route.ts", method: "GET", section: "segments", action: "read" },
  { route: "segments/[id]/route.ts", method: "PATCH", section: "segments", action: "configure" },
  { route: "segments/[id]/route.ts", method: "DELETE", section: "segments", action: "configure" },
  {
    route: "segments/preview/route.ts",
    method: "POST",
    section: "segments",
    action: "configure",
    note: "The preview runs the segment engine; only the configurator calls it",
  },
  { route: "audit/route.ts", method: "GET", section: "audit", action: "read" },
  { route: "pipelines/route.ts", method: "GET", section: "settings", action: "read" },
  { route: "pipelines/route.ts", method: "POST", section: "settings", action: "configure" },
  { route: "pipelines/[id]/route.ts", method: "PATCH", section: "settings", action: "configure" },
  { route: "pipelines/[id]/stages/route.ts", method: "PUT", section: "settings", action: "configure" },
  { route: "custom-fields/route.ts", method: "GET", section: "settings", action: "read" },
  { route: "custom-fields/route.ts", method: "POST", section: "settings", action: "configure" },
  { route: "custom-fields/[id]/route.ts", method: "DELETE", section: "settings", action: "configure" },
  { route: "queues/route.ts", method: "GET", section: "overview", action: "read" },
  {
    route: "saved-views/route.ts",
    method: "GET",
    section: "overview",
    action: "read",
    note: "Smart queues are built on saved views, and both belong to the work surface",
  },
  { route: "saved-views/route.ts", method: "POST", section: "overview", action: "write" },
  { route: "saved-views/route.ts", method: "DELETE", section: "overview", action: "write" },
];

/** The permissions a member is *guaranteed* to hold when a requirement is met. */
function guaranteed(requirement: {
  all: readonly Permission[];
  anyOf?: readonly Permission[];
}): Set<Permission> {
  const base = new Set<Permission>();
  for (const permission of requirement.all) {
    base.add(permission);
    for (const implied of impliedPermissions(permission)) base.add(implied);
  }
  const alternatives = requirement.anyOf ?? [];
  if (alternatives.length === 0) return base;

  // A member satisfies `anyOf` through exactly one alternative, so the only
  // permissions guaranteed are those every alternative would grant.
  let intersection: Set<Permission> | null = null;
  for (const alternative of alternatives) {
    const option = new Set(base);
    option.add(alternative);
    for (const implied of impliedPermissions(alternative)) option.add(implied);
    if (intersection === null) {
      intersection = option;
    } else {
      const kept = new Set<Permission>();
      for (const permission of intersection) {
        if (option.has(permission)) kept.add(permission);
      }
      intersection = kept;
    }
  }
  return intersection ?? base;
}

/** The requirement a route must match: its refinement, else the action's default. */
function requirementFor(entry: RouteAccess): readonly Permission[] | undefined {
  const refinement = crmSectionRoutePermission(
    entry.section,
    `${entry.method} ${entry.route.replace(/\/route\.ts$/, "")}`,
  );
  if (refinement) return refinement;
  if (entry.action === "read") return undefined; // handled by the read rule
  return crmSectionPermission(entry.section, entry.action);
}

/** Every route file in the tree, as `(file, method)` pairs. */
function routeKeysInTree(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`, rel);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const source = readFileSync(`${dir}/${entry.name}`, "utf8");
      for (const match of source.matchAll(/^export const (GET|POST|PATCH|PUT|DELETE)\b/gm)) {
        keys.add(`${rel} ${match[1]}`);
      }
    }
  };
  walk(API_DIR, "");
  return keys;
}

/** The permission one exported method guards with. */
function guardOf(route: string, method: string): string[] {
  const source = readFileSync(`${API_DIR}/${route}`, "utf8");
  const parts = source.split(
    new RegExp(`^export const (GET|POST|PATCH|PUT|DELETE)\\b`, "m"),
  );
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index] !== method) continue;
    return [...parts[index + 1].matchAll(/requirePermission\(PERMISSIONS\.(\w+)\)/g)].map(
      (match) => match[1],
    );
  }
  return [];
}

function permissionKeyOf(name: string): Permission {
  const key = (PERMISSIONS as Record<string, Permission>)[name];
  expect(key, `PERMISSIONS.${name} does not exist`).toBeTruthy();
  return key;
}

describe("the route permission matrix", () => {
  it("classifies every route, and only routes that exist", () => {
    const declared = new Set(ROUTES.map((entry) => `${entry.route} ${entry.method}`));
    const actual = routeKeysInTree();
    expect(
      [...actual].filter((key) => !declared.has(key)),
      "These routes are not in the matrix — add them with the section action they perform",
    ).toEqual([]);
    expect(
      [...declared].filter((key) => !actual.has(key)),
      "The matrix names routes that no longer exist",
    ).toEqual([]);
  });

  it("guards every route with exactly one permission", () => {
    const offenders: string[] = [];
    for (const entry of ROUTES) {
      const guards = guardOf(entry.route, entry.method);
      if (guards.length !== 1) {
        offenders.push(`${entry.method} ${entry.route} → ${guards.length} guards`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("opens the section to everyone its own API admits", () => {
    // Direction one: a section must not be *weaker* than its routes, or the
    // page renders and every request behind it is refused.
    const offenders: string[] = [];
    for (const entry of ROUTES) {
      if (entry.action !== "read") continue;
      const guard = permissionKeyOf(guardOf(entry.route, entry.method)[0]);
      const admitted = guaranteed(CRM_SECTION_ACCESS[entry.section].read);
      if (!admitted.has(guard)) {
        offenders.push(
          `${entry.method} ${entry.route} requires ${guard}, which ${entry.section}.read does not guarantee`,
        );
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These routes refuse members the section gate admits:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("performs each action on the permission the table promises", () => {
    // Direction two: a member the table says may do something must not be
    // refused by the route that does it. Equality, both ways.
    const offenders: string[] = [];
    for (const entry of ROUTES) {
      if (entry.action === "read") continue;
      const requirement = requirementFor(entry);
      if (!requirement) {
        offenders.push(
          `${entry.method} ${entry.route} performs ${entry.section}.${entry.action}, which the table does not declare`,
        );
        continue;
      }
      const guard = new Set<Permission>();
      const guarded = permissionKeyOf(guardOf(entry.route, entry.method)[0]);
      guard.add(guarded);
      for (const implied of impliedPermissions(guarded)) guard.add(implied);

      const promised = new Set<Permission>();
      for (const permission of requirement) {
        promised.add(permission);
        for (const implied of impliedPermissions(permission)) promised.add(implied);
      }

      const promisedButRefused = [...promised].filter((permission) => !guard.has(permission));
      const acceptedButNotPromised = [...guard].filter((permission) => !promised.has(permission));
      if (promisedButRefused.length > 0) {
        offenders.push(
          `${entry.method} ${entry.route} refuses ${promisedButRefused.join(", ")}, which ${entry.section}.${entry.action} promises`,
        );
      }
      if (acceptedButNotPromised.length > 0) {
        offenders.push(
          `${entry.method} ${entry.route} admits ${acceptedButNotPromised.join(", ")}, which ${entry.section}.${entry.action} does not grant`,
        );
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The table and these routes disagree:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("declares a requirement for every action it names", () => {
    for (const entry of ROUTES) {
      if (entry.action === "read") continue;
      const requirement =
        requirementFor(entry) ?? crmSectionPermission(entry.section, entry.action);
      expect(requirement, `${entry.section}.${entry.action} is undeclared`).toBeTruthy();
      expect(requirement!.length).toBeGreaterThan(0);
    }
  });

  it("resolves every declared refinement to a real route", () => {
    const keys = new Set(ROUTES.map((entry) => `${entry.route} ${entry.method}`));
    for (const section of CRM_SECTION_KEYS) {
      for (const [route, permissions] of Object.entries(CRM_SECTION_ACCESS[section].routes ?? {})) {
        const [method, path] = route.split(" ");
        expect(
          keys.has(`${path}/route.ts ${method}`),
          `${section} refines ${route}, which is not a route in the matrix`,
        ).toBe(true);
        expect(permissions.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("who the CRM lets in", () => {
  const permissionsFor = (role: string) => effectivePermissions(role as never, null);

  it("pins the tier each built-in role reaches", () => {
    // A deliberate change to this list is fine; an accidental one is not. The
    // cashier is the line that matters: the floor gets the directory, its own
    // follow-ups and the service desk, and nothing that reads like a forecast.
    const expected: Record<string, CrmSectionKey[]> = {
      owner: [...CRM_SECTION_KEYS].filter((key) => key !== "persons"),
      manager: [...CRM_SECTION_KEYS].filter((key) => key !== "persons"),
      cashier: ["directory", "activities", "cases"],
      accountant: [],
      waiter: [],
    };
    for (const [role, sections] of Object.entries(expected)) {
      const held = permissionsFor(role);
      const admitted = CRM_SECTION_KEYS.filter(
        (key) => key !== "persons" && canViewCrmSection(held, key),
      );
      expect(admitted.sort(), role).toEqual([...sections].sort());
      expect(canOpenCrm(held), role).toBe(sections.length > 0);
    }
  });

  it("refuses to let crm.export substitute for crm.view", () => {
    // The original bug: an OR-list of management keys opened Deals to a member
    // who could not read a single row of it.
    const exporter = new Set<Permission>([PERMISSIONS.crmExport]);
    for (const key of ["overview", "deals", "leads"] as CrmSectionKey[]) {
      expect(canViewCrmSection(exporter, key), key).toBe(false);
    }
    // The management read is three-way on purpose: the base read, the working
    // key (`crm.manage`, so the board's controls are usable), and one of the
    // manager-level keys (`crm.export`/`crm.configure`) — which is what keeps
    // the cashier, who holds the first two, out of the forecast.
    const exporterWithoutManage = new Set<Permission>([PERMISSIONS.crmView, PERMISSIONS.crmExport]);
    expect(canViewCrmSection(exporterWithoutManage, "deals")).toBe(false);
    const managerKeys = new Set<Permission>([
      PERMISSIONS.crmView,
      PERMISSIONS.crmManage,
      PERMISSIONS.crmExport,
    ]);
    expect(canViewCrmSection(managerKeys, "deals")).toBe(true);
    expect(canViewCrmSection(managerKeys, "leads")).toBe(true);
    // Segments are configured, not exported: the same manager keys without
    // `crm.configure` do not open the segment engine.
    expect(canViewCrmSection(managerKeys, "segments")).toBe(false);
  });

  it("keeps a cashier out of everything that is not floor work", () => {
    const cashier = permissionsFor("cashier");
    expect(canViewCrmSection(cashier, "directory")).toBe(true);
    expect(canViewCrmSection(cashier, "cases")).toBe(true);
    for (const key of ["overview", "deals", "leads", "segments", "consent", "audit", "settings", "duplicates", "reconciliation"] as CrmSectionKey[]) {
      expect(canViewCrmSection(cashier, key), key).toBe(false);
    }
  });

  it("draws the case delete control from crm.delete, exactly like the endpoint", () => {
    const cashier = permissionsFor("cashier");
    const manager = permissionsFor("manager");
    expect(canDeleteCrmSection(cashier, "cases")).toBe(false);
    expect(canDeleteCrmSection(manager, "cases")).toBe(true);
    // The old drift, stated as a test: the key the button used to be drawn on
    // is not the key the endpoint requires.
    expect(cashier.has(PERMISSIONS.crmManage)).toBe(true);
    expect(cashier.has(PERMISSIONS.crmDelete)).toBe(false);
  });

  it("closes an action a section does not declare", () => {
    // "Not declared" must never read as "allowed": the forgotten row is how the
    // delete button came to be drawn from the wrong key.
    const manager = permissionsFor("manager");
    expect(crmSectionPermission("deals", "delete")).toBeUndefined();
    expect(canMergeCrmSection(manager, "persons")).toBe(false);
    expect(canWriteCrmSection(manager, "settings")).toBe(false);
    expect(canWriteCrmSection(manager, "overview")).toBe(true);
  });

  it("admits nobody without a CRM or parties key", () => {
    for (const role of ["accountant", "waiter", "kitchen"]) {
      const held = permissionsFor(role);
      expect(canOpenCrm(held), role).toBe(false);
      for (const key of CRM_SECTION_KEYS) {
        expect(canViewCrmSection(held, key), `${role} → ${key}`).toBe(false);
      }
    }
  });
});
