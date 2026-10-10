import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, type ActionType } from "../ai";
import { AI_TOOL_PERMISSION_MAP, aiActionPermission } from "../ai-capabilities";
import { PERMISSIONS } from "../permissions";
import {
  MCP_READ_TOOL_SUMMARIES,
  assertWriteToolsMatchCatalogue,
  findMcpTool,
  isKnownMcpTool,
  mcpReadTools,
  mcpToolCatalogue,
  mcpWriteTools,
} from "./tools";

describe("read tools", () => {
  it("are the assistant's own tools, not a second list to keep in step", () => {
    const names = mcpReadTools().map((tool) => tool.descriptor.name);
    // A sample of what dashboard mode offers. If ai.ts gains a read tool it
    // appears here for free, which is the point.
    expect(names).toContain("run_report");
    expect(names).toContain("find_items");
    expect(names).toContain("describe_app");
    expect(names).toContain("run_accounting_review");
  });

  it("excludes the two tools that cannot mean anything over MCP", () => {
    const names = mcpReadTools().map((tool) => tool.descriptor.name);
    // propose_action is the in-app confirm gate — over MCP a write is a tool
    // the client calls directly, so this would be a second way to ask.
    expect(names).not.toContain("propose_action");
    // draft_expense_from_receipt reads an image attached to the current chat
    // turn, and there is no such attachment here.
    expect(names).not.toContain("draft_expense_from_receipt");
  });

  it("carries an English sentence in front of the Persian description", () => {
    // A client may be driving a model reasoning in English about a Persian
    // business, and a tool it cannot read is a tool it will not call.
    const report = mcpReadTools().find((tool) => tool.descriptor.name === "run_report");
    expect(report?.descriptor.description).toContain("Run one standard report");
    // …never instead of the Persian, which carries the domain rules.
    expect(report?.descriptor.description).toContain("list_reports");
    expect(report?.descriptor.description).toContain("ISO");
  });

  it("has an English summary for every tool it exposes", () => {
    const missing = mcpReadTools()
      .map((tool) => tool.descriptor.name)
      .filter((name) => !MCP_READ_TOOL_SUMMARIES[name]);
    expect(missing).toEqual([]);
  });

  it("annotates every read tool as read-only", () => {
    for (const tool of mcpReadTools()) {
      expect(tool.descriptor.annotations.readOnlyHint).toBe(true);
      expect(tool.descriptor.annotations.destructiveHint).toBe(false);
      expect(tool.scope).toBe("pos.read");
    }
  });

  it("gives every tool an input schema, so a client can validate before calling", () => {
    for (const tool of mcpReadTools()) {
      expect(tool.descriptor.inputSchema).toMatchObject({ type: "object" });
    }
  });
});

describe("write tools", () => {
  it("are exactly the executable, non-coworker-only actions", () => {
    expect(assertWriteToolsMatchCatalogue()).toEqual({ missing: [], extra: [] });
  });

  it("never exposes waste logging", () => {
    // Phase 31 kept waste out of autopilot because "why did this stock leave"
    // is a fact only a person in the room has; Phase 32 let a coworker JOB log
    // it because the owner supplied that fact in advance. A model in a chat
    // window has supplied nothing, so it is back to the Phase 31 position.
    const types = mcpWriteTools().map((tool) =>
      tool.binding.kind === "write" ? tool.binding.actionType : null,
    );
    expect(types).not.toContain("inventory.waste.log");
    expect(ACTION_CATALOG["inventory.waste.log"].coworkerOnly).toBe(true);
  });

  it("never exposes an action with no server-side executor", () => {
    // The setup-wizard six, the live floor five, and menu.item.create were each
    // left without an executor deliberately.
    for (const tool of mcpWriteTools()) {
      const type = tool.binding.kind === "write" ? tool.binding.actionType : ("" as ActionType);
      expect(ACTION_CATALOG[type].executor).toBeTruthy();
    }
    const names = mcpWriteTools().map((tool) => tool.descriptor.name);
    expect(names).not.toContain("write_reservation");
    expect(names).not.toContain("write_menu_item_create");
  });

  it("binds each tool to the executor its catalogue entry names, not to a new path", () => {
    for (const tool of mcpWriteTools()) {
      if (tool.binding.kind !== "write") throw new Error("expected a write binding");
      expect(tool.binding.executor).toBe(ACTION_CATALOG[tool.binding.actionType].executor);
    }
  });

  it("marks a write that cannot be undone as destructive, and none of them idempotent", () => {
    const expense = mcpWriteTools().find((tool) => tool.descriptor.name === "write_expense");
    expect(expense?.descriptor.annotations.destructiveHint).toBe(true);
    const price = mcpWriteTools().find((tool) => tool.descriptor.name === "write_menu_item_price");
    expect(price?.descriptor.annotations.destructiveHint).toBe(false);
    // Calling write_expense twice books the expense twice; a client retrying on
    // a timeout has to be told so.
    for (const tool of mcpWriteTools()) {
      expect(tool.descriptor.annotations.idempotentHint).toBe(false);
      expect(tool.descriptor.annotations.readOnlyHint).toBe(false);
    }
  });

  it("names every required payload field in its own schema", () => {
    const price = mcpWriteTools().find((tool) => tool.descriptor.name === "write_menu_item_price");
    expect(price?.descriptor.inputSchema).toMatchObject({
      required: ["menuItemId", "price"],
      additionalProperties: false,
    });
  });

  it("gives every write tool a distinct name in the write_ namespace", () => {
    const names = mcpWriteTools().map((tool) => tool.descriptor.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("write_")).toBe(true);
  });
});

describe("mcpToolCatalogue", () => {
  it("hides write tools from a read-only connection entirely", () => {
    // Not merely refuses them: a model that can see a tool keeps proposing it
    // and telling the owner the app refused.
    const names = mcpToolCatalogue(["pos.read"]).map((tool) => tool.descriptor.name);
    expect(names.some((name) => name.startsWith("write_"))).toBe(false);
    expect(names).toContain("run_report");
  });

  it("hides read tools from a write-only connection", () => {
    const names = mcpToolCatalogue(["pos.write"]).map((tool) => tool.descriptor.name);
    expect(names).not.toContain("run_report");
    expect(names).toContain("write_expense");
  });

  it("gives a connection with both grants both halves", () => {
    const both = mcpToolCatalogue(["pos.read", "pos.write"]);
    expect(both.length).toBe(mcpReadTools().length + mcpWriteTools().length + 1);
    // The +1 is the own-connection get_write_status native tool (issue #883
    // A4): it is exposed on write scope alone, no domain permission needed.
    expect(both.map((tool) => tool.descriptor.name)).toContain("get_write_status");
  });

  it("uses names that satisfy MCP's own tool-name rule", () => {
    for (const tool of mcpToolCatalogue(["pos.read", "pos.write"])) {
      expect(tool.descriptor.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });
});

describe("findMcpTool / isKnownMcpTool", () => {
  it("tells 'you may not' apart from 'no such thing'", () => {
    // The two answers make a model behave differently: the first is worth
    // telling the user about, the second means it should stop trying.
    expect(findMcpTool("write_expense", ["pos.read"])).toBeNull();
    expect(isKnownMcpTool("write_expense")).toBe(true);
    expect(findMcpTool("nonsense", ["pos.read", "pos.write"])).toBeNull();
    expect(isKnownMcpTool("nonsense")).toBe(false);
  });

  it("finds a tool the connection does hold", () => {
    expect(findMcpTool("run_report", ["pos.read"])?.binding).toEqual({
      kind: "read",
      readToolName: "run_report",
    });
  });
});

describe("permission-filtered catalogue (issue #883 P0-1)", () => {
  // The authorizer's *current* effective set, exactly what their own session
  // carries — here a floor role (cashier-shaped): the till and the menu, never
  // the books, the payroll or the report engine.
  const floorPermissions = new Set([
    PERMISSIONS.aiUse,
    PERMISSIONS.menuView,
    PERMISSIONS.menuEdit,
    PERMISSIONS.ordersView,
    PERMISSIONS.ordersDiscount,
    PERMISSIONS.inventoryView,
  ]);

  it("hides reads the authorizer's current permissions do not cover", () => {
    const names = mcpToolCatalogue(["pos.read"], floorPermissions).map(
      (tool) => tool.descriptor.name,
    );
    expect(names).toContain("find_items");
    expect(names).toContain("get_menu_performance");
    expect(names).not.toContain("run_report");
    expect(names).not.toContain("get_payroll_summary");
    expect(names).not.toContain("find_customers");
  });

  it("hides writes whose action permission is missing, and fails closed on unmapped actions", () => {
    const names = mcpToolCatalogue(["pos.write"], floorPermissions).map(
      (tool) => tool.descriptor.name,
    );
    // menu.edit is held → the two menu writes stay…
    expect(names).toContain("write_menu_item_price");
    expect(names).toContain("write_menu_item_availability");
    expect(names).toContain("write_order_discount");
    // …everything gated on accounting/CRM/inventory-adjust rights does not.
    expect(names).not.toContain("write_expense");
    expect(names).not.toContain("write_journal_draft");
    expect(names).not.toContain("write_crm_customer_note");
    expect(names).not.toContain("write_stock_count");
  });

  it("an empty permission set sees nothing but its own write status", () => {
    // Every data-bearing tool disappears; the single survivor is the native
    // get_write_status tool, which answers only about audit rows this very
    // connection created — the connection's own traffic, not tenant data.
    const names = mcpToolCatalogue(["pos.read", "pos.write"], new Set()).map(
      (tool) => tool.descriptor.name,
    );
    expect(names).toEqual(["get_write_status"]);
  });

  it("every exposed read tool has an entry in the permission map — fail closed otherwise", () => {
    // canUseAiTool denies unmapped tools; this asserts the catalogue and the
    // map cannot drift so that a read tool silently disappears for everyone.
    for (const tool of mcpReadTools()) {
      if (tool.binding.kind !== "read") throw new Error("expected a read binding");
      expect(AI_TOOL_PERMISSION_MAP[tool.binding.readToolName], tool.binding.readToolName)
        .toBeDefined();
    }
  });

  it("every exposed write maps to a domain permission", () => {
    for (const tool of mcpWriteTools()) {
      if (tool.binding.kind !== "write") throw new Error("expected a write binding");
      expect(aiActionPermission(tool.binding.actionType), tool.binding.actionType).not.toBeNull();
    }
  });

  it("findMcpTool applies the same second filter", () => {
    expect(findMcpTool("run_report", ["pos.read"], floorPermissions)).toBeNull();
    expect(findMcpTool("run_report", ["pos.read"], new Set([PERMISSIONS.reportsView])))
      .not.toBeNull();
    // …but isKnownMcpTool stays scope-level, so 'no access' ≠ 'no such tool'.
    expect(isKnownMcpTool("run_report")).toBe(true);
  });
});
