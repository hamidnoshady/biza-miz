/**
 * Issue #799 §23 — the AEC read tools' catalogue contract and their refusals.
 *
 * What needs no database is asserted here: the names are the ones §23 chose,
 * every one has a Persian label, the permission map covers each of them, the
 * model-facing catalogue actually defines them, and a business of another
 * industry is refused with a sentence rather than answered with an empty list.
 * The data the tools read is covered in `integration/aec.integration.test.ts`
 * and `integration/aec-document-control.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { AEC_AI_TOOL_LABELS, AEC_AI_TOOL_NAMES, isAecAiToolName } from "./aec";
import { runAecReadTool } from "./aec-ai-tools";
import { AI_TOOL_PERMISSION_MAP } from "./ai-capabilities";
import { READ_TOOL_NAMES } from "./ai-tools";
import { toolDefinitions } from "./ai";

describe("the AEC read tools", () => {
  it("declares exactly the tree the issue names", () => {
    // Wave 3 shipped §23's first two; Wave 4 added `get_boq_variance` because
    // the data it reads (the approved estimate and the ledger's actual cost)
    // only then existed; Wave 5 added `get_latest_drawing_revision`, which the
    // issue names in §23 and whose register arrived with §9. The list is
    // asserted literally so a fifth cannot arrive unnoticed.
    expect([...AEC_AI_TOOL_NAMES]).toEqual([
      "get_aec_project_financial_health",
      "list_delayed_project_activities",
      "get_boq_variance",
      "get_latest_drawing_revision",
    ]);
    expect(isAecAiToolName("get_aec_project_financial_health")).toBe(true);
    expect(isAecAiToolName("get_workspace_project_status")).toBe(false);
  });

  it("labels each one in Persian and registers a permission for it", () => {
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(AEC_AI_TOOL_LABELS[name]?.trim().length, name).toBeGreaterThan(0);
      // Fails closed: an unregistered tool is denied, so a tool with no entry
      // would be advertised to the model and then always refused.
      expect(AI_TOOL_PERMISSION_MAP[name], name).toBe("workspace.view");
    }
    expect(Object.keys(AEC_AI_TOOL_LABELS).sort()).toEqual([...AEC_AI_TOOL_NAMES].sort());
  });

  it("is executable and model-visible", () => {
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(READ_TOOL_NAMES.has(name), name).toBe(true);
    }
    const defined = new Set(
      toolDefinitions("dashboard").map((tool) => tool.function.name),
    );
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(defined.has(name), name).toBe(true);
    }
  });

  // Every tool, including the drawing read whose register arrived in Wave 5, is
  // refused here before it can reach the database — which is also why this file
  // needs no database of its own.
  it("refuses another industry in words the model can relay", async () => {
    for (const industry of ["food_service", "service_saas", null]) {
      for (const name of AEC_AI_TOOL_NAMES) {
        const result = await runAecReadTool(
          name,
          {},
          "00000000-0000-0000-0000-000000000000",
          industry,
        );
        expect(result.ok, `${name} for ${industry}`).toBe(false);
        expect(result.error).toContain("عمران");
      }
    }
  });

  it("refuses a name that is not one of its own", async () => {
    const result = await runAecReadTool(
      "get_workspace_project_status",
      {},
      "00000000-0000-0000-0000-000000000000",
      "architecture_construction",
    );
    expect(result.ok).toBe(false);
  });
});
