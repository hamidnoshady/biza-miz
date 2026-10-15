import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_TASK_CHARS } from "./ai-attachment-limits";
import {
  AI_TASKS,
  CUSTOM_TASK_FRAME,
  SUGGESTED_PROMPTS,
  isFocusEligible,
  isTaskEligible,
  resolveAccessibleFocuses,
  resolveEligibleTasks,
  resolveStarterPrompts,
  resolveTenantTaskFeatures,
  sanitizeCustomTask,
  taskById,
  taskDirectiveFor,
  taskSuggestions,
} from "./ai-tasks";

describe("AI task catalog", () => {
  it("every id is unique and every task declares where it belongs", () => {
    const ids = AI_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of AI_TASKS) {
      expect(task.modes.length).toBeGreaterThan(0);
      expect(task.modes.every((mode) => mode === "dashboard" || mode === "floor")).toBe(true);
    }
  });

  it("exposes a lookup and starter suggestions", () => {
    expect(taskById("sales")?.label).toBe("تحلیل فروش");
    const sales = taskSuggestions("sales", "dashboard", ["fallback"]);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales).not.toEqual(["fallback"]);
    expect(taskSuggestions("general", "dashboard", ["fallback"])).toEqual(["fallback"]);
  });

  it("keeps default dashboard SUGGESTED_PROMPTS free of hospitality-only menu prompts", () => {
    for (const prompt of SUGGESTED_PROMPTS.dashboard) {
      expect(prompt).not.toContain("منو");
    }
  });
});

describe("sanitizeCustomTask", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeCustomTask("  a\u0000b\r\nc\t d  ")).toBe("a b c d");
  });

  it("caps the length", () => {
    expect(sanitizeCustomTask("x".repeat(MAX_CUSTOM_TASK_CHARS + 50))).toHaveLength(
      MAX_CUSTOM_TASK_CHARS,
    );
  });
});

describe("taskDirectiveFor", () => {
  it("returns the directive for a known task in a matching mode", () => {
    const directive = taskDirectiveFor({ task: "sales", mode: "dashboard" });
    expect(directive).toBe(taskById("sales")?.directive);
    expect(directive).toContain("فروش");
  });

  it("ignores a task that does not belong to the mode", () => {
    expect(taskDirectiveFor({ task: "sales", mode: "floor" })).toBeNull();
    expect(taskDirectiveFor({ task: "split", mode: "dashboard" })).toBeNull();
    expect(taskDirectiveFor({ task: "general", mode: "wizard" })).toBeNull();
  });

  it("ignores unknown ids instead of failing", () => {
    expect(taskDirectiveFor({ task: "not-a-task", mode: "dashboard" })).toBeNull();
    expect(taskDirectiveFor({ task: 42, mode: "dashboard" })).toBeNull();
  });

  it("frames a custom task and lets it win over a preset id", () => {
    const directive = taskDirectiveFor({
      task: "sales",
      customTask: "  فقط دربارهٔ چای و قهوه جواب بده \u0000",
      mode: "dashboard",
    });
    expect(directive).toBe(`${CUSTOM_TASK_FRAME}فقط دربارهٔ چای و قهوه جواب بده`);
    expect(directive).not.toContain("تمرکز این گفتگو تحلیل فروش");
  });

  it("falls back to the preset id when the custom text is empty or not a string", () => {
    expect(taskDirectiveFor({ task: "sales", customTask: "   ", mode: "dashboard" })).toContain(
      "تحلیل فروش",
    );
    expect(
      taskDirectiveFor({ task: "sales", customTask: { evil: true }, mode: "dashboard" }),
    ).toContain("تحلیل فروش");
  });

  it("rejects ineligible preset directives on the server when eligibility context does not match", () => {
    expect(
      taskDirectiveFor({
        task: "menu",
        mode: "dashboard",
        eligibility: { industry: "service_saas" },
      }),
    ).toBeNull();

    expect(
      taskDirectiveFor({
        task: "operations",
        mode: "dashboard",
        eligibility: { industry: "jewelry" },
      }),
    ).toBeNull();

    expect(
      taskDirectiveFor({
        task: "menu",
        mode: "dashboard",
        eligibility: { industry: "food_service", permissions: ["menu.view"] },
      }),
    ).toContain("منو و قیمت‌گذاری");

    expect(
      taskDirectiveFor({
        task: "accounting",
        mode: "dashboard",
        eligibility: { industry: "wholesale", permissions: ["customers.view"] },
      }),
    ).toBeNull();

    // Feature-flag gating on taskDirectiveFor
    expect(
      taskDirectiveFor({
        task: "inventory",
        mode: "dashboard",
        eligibility: {
          industry: "food_service",
          features: { inventory: false },
          permissions: ["inventory.view"],
        },
      }),
    ).toBeNull();

    expect(
      taskDirectiveFor({
        task: "accounting",
        mode: "dashboard",
        eligibility: {
          industry: "food_service",
          features: { ledger: false },
          permissions: ["ledger.view"],
        },
      }),
    ).toBeNull();
  });
});

describe("isTaskEligible, resolveEligibleTasks, and resolveStarterPrompts", () => {
  it("filters hospitality tasks out for non-food_service industries and omits duplicate custom when includeCustom is false", () => {
    const saasTasks = resolveEligibleTasks(
      { mode: "dashboard", industry: "service_saas" },
      { includeCustom: false },
    ).map((t) => t.id);

    expect(saasTasks).toContain("general");
    expect(saasTasks).toContain("sales");
    expect(saasTasks).toContain("accounting");
    expect(saasTasks).toContain("customers");
    expect(saasTasks).toContain("marketing");
    expect(saasTasks).not.toContain("menu");
    expect(saasTasks).not.toContain("operations");
    expect(saasTasks).not.toContain("delivery");
    expect(saasTasks).not.toContain("inventory");
    expect(saasTasks).not.toContain("custom");

    const foodTasks = resolveEligibleTasks(
      { mode: "dashboard", industry: "food_service" },
      { includeCustom: false },
    ).map((t) => t.id);
    expect(foodTasks).toContain("menu");
    expect(foodTasks).toContain("operations");
    expect(foodTasks).toContain("delivery");
    expect(foodTasks).toContain("inventory");

    expect(
      isTaskEligible("accounting", {
        mode: "dashboard",
        industry: "wholesale",
        permissions: ["customers.view"],
      }),
    ).toBe(false);
  });

  it("never returns restaurant menu starter prompts for non-hospitality tenants", () => {
    const prompts = resolveStarterPrompts({
      mode: "dashboard",
      industry: "architecture_construction",
    });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("منو");
      expect(prompt).not.toContain("میز");
    }

    const projectPrompts = resolveStarterPrompts({
      mode: "dashboard",
      industry: "architecture_construction",
      projectId: "proj-1",
    });
    expect(projectPrompts[0]).toContain("پروژه");
  });

  it("normalizes DB feature flags and app availability via resolveTenantTaskFeatures (including retail stock vs F&B inventory)", () => {
    // Retail trade (`jewelry`) seeds `inventory: false` in DB `defaultDisabledFeatures`,
    // while using module `stock`. `resolveTenantTaskFeatures` keeps `inventory` task feature enabled for retail stock.
    const jewelryFeatures = resolveTenantTaskFeatures(
      { inventory: false, reservations: false, delivery: false, ledger: true, reporting: true },
      { industry: "jewelry" },
    );
    expect(jewelryFeatures.inventory).toBe(true);
    expect(
      isTaskEligible("inventory", {
        mode: "dashboard",
        industry: "jewelry",
        features: jewelryFeatures,
        permissions: ["inventory.view"],
      }),
    ).toBe(true);

    // Food service with `inventory: false` in DB disables the `inventory` task
    const cafeFeatures = resolveTenantTaskFeatures(
      { inventory: false, reservations: false, delivery: false, ledger: true, reporting: true },
      { industry: "food_service" },
    );
    expect(cafeFeatures.inventory).toBe(false);
    expect(cafeFeatures.reservations).toBe(false);
    expect(cafeFeatures.delivery).toBe(false);
    expect(
      isTaskEligible("inventory", {
        mode: "dashboard",
        industry: "food_service",
        features: cafeFeatures,
        permissions: ["inventory.view"],
      }),
    ).toBe(false);
    expect(
      isTaskEligible("operations", {
        mode: "dashboard",
        industry: "food_service",
        features: cafeFeatures,
        permissions: ["tables.manage"],
      }),
    ).toBe(false);
    expect(
      isTaskEligible("delivery", {
        mode: "dashboard",
        industry: "food_service",
        features: cafeFeatures,
        permissions: ["delivery.manage"],
      }),
    ).toBe(false);
  });

  it("ensures restricted users never receive task options, focuses, or starter suggestions for unavailable functions", () => {
    // 1. User with ONLY `inventory.view` (no ledger, reports, workspace, CRM, growth, website)
    const invOnlyContext = {
      mode: "dashboard" as const,
      industry: "wholesale" as const,
      permissions: ["ai.use", "inventory.view"],
    };
    const invTasks = resolveEligibleTasks(invOnlyContext, { includeCustom: false }).map(
      (t) => t.id,
    );
    expect(invTasks).toEqual(["general", "inventory"]);

    const invFocuses = resolveAccessibleFocuses(invOnlyContext);
    expect(invFocuses).toEqual(["all", "accounting"]);
    expect(isFocusEligible("workspace", invOnlyContext)).toBe(false);
    expect(isFocusEligible("crm", invOnlyContext)).toBe(false);

    // Default "all" focus starters must ONLY suggest inventory prompts, never sales/ledger/workspace/CRM
    const invStartersAll = resolveStarterPrompts(invOnlyContext);
    expect(invStartersAll).toEqual(taskById("inventory")!.suggestions);

    // Even when `appFocus: "accounting"` is active, restricted user only gets inventory prompts (not ledger/sales)
    const invStartersAccounting = resolveStarterPrompts({
      ...invOnlyContext,
      appFocus: "accounting",
    });
    expect(invStartersAccounting).toEqual(taskById("inventory")!.suggestions);

    // Even when `projectId` is passed, restricted user without `workspace.view` does NOT get project prompts
    const invStartersWithProject = resolveStarterPrompts({
      ...invOnlyContext,
      projectId: "proj-1",
    });
    expect(invStartersWithProject).toEqual(taskById("inventory")!.suggestions);
    for (const p of invStartersWithProject) {
      expect(p).not.toContain("پروژه");
    }

    // 2. User with ONLY `ai.use` and zero domain permissions
    const chatOnlyContext = {
      mode: "dashboard" as const,
      industry: "food_service" as const,
      permissions: ["ai.use"],
    };
    expect(
      resolveEligibleTasks(chatOnlyContext, { includeCustom: false }).map((t) => t.id),
    ).toEqual(["general"]);
    expect(resolveAccessibleFocuses(chatOnlyContext)).toEqual(["all"]);
    const chatOnlyStarters = resolveStarterPrompts(chatOnlyContext);
    expect(chatOnlyStarters).toHaveLength(3);
    for (const prompt of chatOnlyStarters) {
      expect(prompt).not.toContain("فروش");
      expect(prompt).not.toContain("حساب");
      expect(prompt).not.toContain("پروژه");
      expect(prompt).not.toContain("منو");
      expect(prompt).not.toContain("مشتریان در خطر");
    }

    // 3. Floor mode with `reservations: false` excludes table bill-split prompt
    const floorNoTables = resolveStarterPrompts({
      mode: "floor",
      industry: "food_service",
      features: { reservations: false },
      permissions: ["menu.view"],
    });
    expect(floorNoTables.some((p) => p.includes("میز"))).toBe(false);
    expect(floorNoTables.some((p) => p.includes("منو"))).toBe(true);
  });
});
