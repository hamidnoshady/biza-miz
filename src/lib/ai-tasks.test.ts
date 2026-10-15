import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_TASK_CHARS } from "./ai-attachment-limits";
import {
  AI_TASKS,
  CUSTOM_TASK_FRAME,
  SUGGESTED_PROMPTS,
  isTaskEligible,
  resolveEligibleTasks,
  resolveStarterPrompts,
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
});
