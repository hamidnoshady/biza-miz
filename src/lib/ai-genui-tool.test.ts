import { describe, expect, it } from "vitest";
import { runReadTool } from "./ai-tools";
import { PERMISSIONS, type Permission } from "./permissions";

const BUSINESS = "00000000-0000-0000-0000-000000000001";

describe("show_report_widget executor", () => {
  it("refuses a source that is not registered", async () => {
    const result = await runReadTool("show_report_widget", { source: "journal_lines" }, BUSINESS, undefined, "u1", new Set<Permission>([PERMISSIONS.aiUse]));
    expect(result).toEqual({ ok: false, data: { error: "unknown_widget_source" } });
  });

  it("does not draw receivables for a member who cannot read them", async () => {
    // aiUse alone opens the widget tool; the underlying read still demands its own permission.
    const result = await runReadTool("show_report_widget", { source: "ar_aging" }, BUSINESS, undefined, "u1", new Set<Permission>([PERMISSIONS.aiUse]));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain("blocks");
  });

  it("is refused outright without the assistant permission", async () => {
    const result = await runReadTool("show_report_widget", { source: "ar_aging" }, BUSINESS, undefined, "u1", new Set<Permission>());
    expect(result.ok).toBe(false);
  });
});
