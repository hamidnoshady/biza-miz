/**
 * Issue #1546 — progress shown to the member must be safe by construction.
 *
 * The label is derived from the tool's own name and section, so these tests
 * assert exactly that: a known tool gets a specific Persian label, an unknown
 * one gets a generic one, and no label can be built from arguments, results or
 * the prompt.
 */
import { describe, expect, it } from "vitest";
import { toolProgressEvent, toolProgressLabel } from "./ai-tool-progress";

describe("toolProgressLabel", () => {
  it("names the tools a member waits on longest", () => {
    expect(toolProgressLabel("run_report")).toBe("در حال اجرای گزارش");
    expect(toolProgressLabel("get_vat_liability")).toContain("مالیات");
  });

  it("falls back to the tool's own section, not to its name", () => {
    const label = toolProgressLabel("list_journal_entries");
    expect(label).toBe("در حال بررسی اسناد و حساب‌ها");
    expect(label).not.toContain("list_journal_entries");
  });

  it("uses a generic label for anything unclassified", () => {
    expect(toolProgressLabel("totally_new_tool")).toBe("در حال بررسی داده‌ها");
  });
});

describe("toolProgressEvent", () => {
  it("carries status, name, label and round — never an argument", () => {
    const event = toolProgressEvent("find_customers", "running", 2);
    expect(event).toEqual({
      status: "running",
      tool: "find_customers",
      label: "در حال جست‌وجوی مشتریان",
      round: 2,
    });
    expect(Object.keys(event).sort()).toEqual(["label", "round", "status", "tool"]);
  });

  it("marks failure distinctly from completion", () => {
    expect(toolProgressEvent("run_report", "completed", 1).status).toBe("completed");
    expect(toolProgressEvent("run_report", "failed", 1).status).toBe("failed");
  });
});
