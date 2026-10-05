import { describe, expect, it } from "vitest";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  PROJECT_MEMORY_CHAR_LIMIT,
  PROJECT_MEMORY_MAX_ENTRIES,
  PROJECT_TASK_CHAR_LIMIT,
  PROJECT_TASK_MAX_OPEN,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";
import {
  buildProjectPromptContext,
  type AiProjectNote,
  type AiProjectMemory,
  type AiProjectTask,
  type ProjectContext,
} from "./ai-projects";

function memory(content: string, source: "user" | "ai" = "user"): AiProjectMemory {
  return {
    id: content, projectId: "p1", content, source,
    createdBy: "u1", createdAt: "", updatedAt: "",
  };
}

function task(title: string, source: "user" | "ai" = "user"): AiProjectTask {
  return {
    id: title, projectId: "p1", title, status: "open", source,
    createdBy: "u1", createdAt: "", completedAt: null, updatedAt: "",
  };
}

describe("instructionWeight", () => {
  it("counts instructions length plus all note title lengths", () => {
    expect(instructionWeight("hello", ["a", "bb", "ccc"])).toBe(5 + 1 + 2 + 3);
  });

  it("returns 0 for empty inputs", () => {
    expect(instructionWeight("", [])).toBe(0);
  });

  it("handles instructions only", () => {
    expect(instructionWeight("some instructions", [])).toBe(17);
  });

  it("handles notes only", () => {
    expect(instructionWeight("", ["note1", "note2"])).toBe(10);
  });
});

describe("isOverInstructionLimit", () => {
  it("returns false at exactly the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT)).toBe(false);
  });

  it("returns false under the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT - 1)).toBe(false);
  });

  it("returns true over the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT + 1)).toBe(true);
  });

  it("returns false for zero", () => {
    expect(isOverInstructionLimit(0)).toBe(false);
  });
});

describe("clampInstructions", () => {
  it("returns instructions unchanged when under the limit", () => {
    const instructions = "short";
    expect(clampInstructions(instructions, [])).toBe(instructions);
  });

  it("trims instructions to fit within the budget after note titles", () => {
    const titles = ["a".repeat(1000)];
    const instructions = "b".repeat(5000);
    const result = clampInstructions(instructions, titles);
    expect(result.length).toBe(PROJECT_INSTRUCTION_CHAR_LIMIT - 1000);
  });

  it("returns empty string when note titles consume the entire budget", () => {
    const titles = ["a".repeat(PROJECT_INSTRUCTION_CHAR_LIMIT)];
    expect(clampInstructions("anything", titles)).toBe("");
  });

  it("returns empty string when note titles exceed the budget", () => {
    const titles = ["a".repeat(PROJECT_INSTRUCTION_CHAR_LIMIT + 100)];
    expect(clampInstructions("anything", titles)).toBe("");
  });
});

describe("buildProjectPromptContext", () => {
  it("includes instructions when present", () => {
    const result = buildProjectPromptContext("Be helpful", []);
    expect(result).toContain("دستور پروژه");
    expect(result).toContain("Be helpful");
  });

  it("includes note titles when present", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "Budget plan", content: "", createdBy: "u1", createdAt: "" },
      { id: "2", projectId: "p1", title: "Timeline", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext("", notes);
    expect(result).toContain("یادداشت‌های پروژه");
    expect(result).toContain("Budget plan");
    expect(result).toContain("Timeline");
  });

  it("includes both instructions and notes", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "Note A", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext("Focus on sales", notes);
    expect(result).toContain("دستور پروژه");
    expect(result).toContain("Focus on sales");
    expect(result).toContain("یادداشت‌های پروژه");
    expect(result).toContain("Note A");
  });

  it("returns empty string when both are empty", () => {
    expect(buildProjectPromptContext("", [])).toBe("");
  });

  it("returns empty string when instructions are only whitespace", () => {
    expect(buildProjectPromptContext("   ", [])).toBe("");
  });
});

describe("buildProjectPromptContext (Phase F — ProjectContext form)", () => {
  const base: ProjectContext = { name: "کمپین بهار", instructions: "", notes: [], memory: [], openTasks: [] };

  it("names the project when a ProjectContext is passed", () => {
    const result = buildProjectPromptContext({ ...base, instructions: "روی فروش تمرکز کن" });
    expect(result).toContain("کمپین بهار");
    expect(result).toContain("روی فروش تمرکز کن");
  });

  it("renders memory as a bulleted 'remember this' block", () => {
    const result = buildProjectPromptContext({
      ...base,
      memory: [memory("مالک تومان را رند می‌کند"), memory("مشتریان هدف ناهارِ ازدست‌رفته", "ai")],
    });
    expect(result).toContain("حافظهٔ پروژه");
    expect(result).toContain("مالک تومان را رند می‌کند");
    expect(result).toContain("مشتریان هدف ناهارِ ازدست‌رفته");
  });

  it("combines name, instructions, notes and memory in one block", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "برنامهٔ بودجه", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext({
      name: "پروژهٔ رشد",
      instructions: "لحن دوستانه",
      notes,
      memory: [memory("هفتهٔ اول تخفیف ندارد")],
      openTasks: [task("تماس با تأمین‌کننده")],
    });
    expect(result).toContain("پروژهٔ رشد");
    expect(result).toContain("لحن دوستانه");
    expect(result).toContain("برنامهٔ بودجه");
    expect(result).toContain("هفتهٔ اول تخفیف ندارد");
    expect(result).toContain("تماس با تأمین‌کننده");
  });

  it("lists only OPEN tasks under a 'کارهای باز' heading", () => {
    const result = buildProjectPromptContext({
      ...base,
      openTasks: [task("پیش‌نویس تخفیف نوروز"), task("رزرو عکاس")],
    });
    expect(result).toContain("کارهای باز پروژه");
    expect(result).toContain("پیش‌نویس تخفیف نوروز");
    expect(result).toContain("رزرو عکاس");
  });

  it("returns empty string when a ProjectContext has nothing to say (name still shows)", () => {
    // A bare name is still context worth stating, so it is never empty when a
    // project is named. An unnamed, empty context is empty.
    expect(
      buildProjectPromptContext({ name: "", instructions: "  ", notes: [], memory: [], openTasks: [] }),
    ).toBe("");
  });

  it("stays backward compatible with the legacy (instructions, notes) call", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "یادداشت", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext("دستور", notes);
    expect(result).toContain("دستور");
    expect(result).toContain("یادداشت");
    expect(result).not.toContain("حافظهٔ پروژه");
  });
});

describe("project memory bounds", () => {
  it("caps a single memory entry and the entry count with sane defaults", () => {
    expect(PROJECT_MEMORY_CHAR_LIMIT).toBeGreaterThan(0);
    expect(PROJECT_MEMORY_MAX_ENTRIES).toBeGreaterThan(0);
    // A memory is a fact, not a document — much smaller than the instruction budget.
    expect(PROJECT_MEMORY_CHAR_LIMIT).toBeLessThan(PROJECT_INSTRUCTION_CHAR_LIMIT);
  });
});

describe("project task bounds", () => {
  it("caps a task title tighter than a memory fact, and caps open tasks", () => {
    expect(PROJECT_TASK_CHAR_LIMIT).toBeGreaterThan(0);
    expect(PROJECT_TASK_MAX_OPEN).toBeGreaterThan(0);
    // A task title is one line — tighter than a memory fact.
    expect(PROJECT_TASK_CHAR_LIMIT).toBeLessThan(PROJECT_MEMORY_CHAR_LIMIT);
  });
});
