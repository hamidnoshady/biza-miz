import { describe, expect, it } from "vitest";
import { toolDefinitions, type OpenAiTool } from "./ai";
import {
  AI_ACTION_PERMISSION_MAP,
  AI_TOOL_PERMISSION_MAP,
  allowedAiActions,
  canUseAiTool,
  filterAiToolsByPermissions,
} from "./ai-capabilities";
import { PERMISSIONS, type Permission } from "./permissions";
import { runReadTool } from "./ai-tools";

const permissions = (...values: Permission[]) => new Set(values);

describe("AI capability policy", () => {
  it("maps every dashboard data tool so future tools fail closed deliberately", () => {
    const protocol = new Set(["propose_action", "request_input"]);
    const dataTools = toolDefinitions("dashboard", { retrieval: true, hasAttachment: true })
      .map((tool) => tool.function.name)
      .filter((name) => !protocol.has(name));

    expect(dataTools.filter((name) => !AI_TOOL_PERMISSION_MAP[name])).toEqual([]);
  });

  it("does not expose payroll through AI to a manager without payroll.view", () => {
    const effective = permissions(PERMISSIONS.aiUse, PERMISSIONS.settingsManage);
    const tools = filterAiToolsByPermissions(toolDefinitions("dashboard"), effective);

    expect(canUseAiTool("get_payroll_summary", effective)).toBe(false);
    expect(tools.map((tool) => tool.function.name)).not.toContain("get_payroll_summary");
  });

  it("allows a domain tool only when its effective permission is present", () => {
    const blocked = permissions(PERMISSIONS.aiUse);
    const allowed = permissions(PERMISSIONS.aiUse, PERMISSIONS.crmView);

    expect(canUseAiTool("find_customers", blocked)).toBe(false);
    expect(canUseAiTool("find_customers", allowed)).toBe(true);
  });

  it("re-checks effective permission in the executor before touching domain data", async () => {
    const result = await runReadTool(
      "get_payroll_summary",
      {},
      "00000000-0000-0000-0000-000000000001",
      undefined,
      "actor-1",
      permissions(PERMISSIONS.aiUse, PERMISSIONS.settingsManage),
    );

    expect(result).toEqual({ ok: false, data: { error: "دسترسی لازم برای این ابزار را ندارید." } });
  });

  it("denies unknown tools rather than accidentally exposing future capabilities", () => {
    const unknown: OpenAiTool = {
      type: "function",
      function: { name: "future_unregistered_tool", description: "test", parameters: { type: "object", properties: {} } },
    };
    expect(filterAiToolsByPermissions([unknown], new Set(Object.values(PERMISSIONS)))).toEqual([]);
  });

  it("intersects an agent action allowlist with effective permissions", () => {
    const requested = ["reservation.create", "crm.customer.note", "menu.item.create"] as const;
    expect(allowedAiActions(requested, permissions(PERMISSIONS.reservationsManage))).toEqual(["reservation.create"]);
  });

  it("has an explicit permission for every action entry", () => {
    expect(Object.values(AI_ACTION_PERMISSION_MAP).every(Boolean)).toBe(true);
  });
});
