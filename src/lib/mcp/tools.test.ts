import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, type ActionType } from "../ai";
import { AI_TOOL_PERMISSION_MAP, aiActionPermission } from "../ai-capabilities";
import { PERMISSIONS } from "../permissions";
import { LEGACY_GRANTS, parseMcpGrants } from "./grants";
import { mcpModuleForReadTool, mcpModuleForWriteAction } from "./registry";
import {
  MCP_READ_TOOL_SUMMARIES,
  MCP_TOOLS_PAGE_SIZE,
  assertWriteToolsMatchCatalogue,
  findMcpTool,
  isKnownMcpTool,
  mcpAvailableModules,
  mcpReadTools,
  mcpToolCatalogue,
  mcpWriteTools,
  paginateMcpTools,
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
    // The setup-wizard six and the live floor five are left without an
    // executor deliberately. menu.item.create USED to be on that list —
    // issue #883 batch C closed it: the executor now mirrors the designer's
    // POST /api/menu/items service, so the tool must be exposed here too.
    for (const tool of mcpWriteTools()) {
      const type = tool.binding.kind === "write" ? tool.binding.actionType : ("" as ActionType);
      expect(ACTION_CATALOG[type].executor).toBeTruthy();
    }
    const names = mcpWriteTools().map((tool) => tool.descriptor.name);
    expect(names).not.toContain("write_reservation");
    // Exposed since batch C (#883) with menuItemCreate as executor.
    expect(names).toContain("write_menu_item_create");
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

describe("P1: tenant module filtering & advertised module parity", () => {
  it("excludes non-food_service trade modules from food_service tools/list and findMcpTool", () => {
    const tools = mcpToolCatalogue(
      ["pos.read", "pos.write"],
      undefined,
      LEGACY_GRANTS,
      { industry: "food_service", writeMode: "approve" },
    );
    const names = tools.map((t) => t.descriptor.name);
    for (const forbidden of [
      "jewelry",
      "aec",
      "cosmetics",
      "cosmetic",
      "wholesale",
      "haberdashery",
      "tools_fittings",
      "accessories",
      "accessory",
      "pricelist",
      "product_attribute",
      "barcode_template",
      "sales_invoice",
      "boq",
      "rfi",
    ]) {
      expect(
        names.filter((n) => n.includes(forbidden)),
        `unexpected ${forbidden} tools on food_service`,
      ).toEqual([]);
    }
    expect(
      findMcpTool("write_jewelry_item_create", ["pos.read", "pos.write"], undefined, LEGACY_GRANTS, {
        industry: "food_service",
      }),
    ).toBeNull();
    expect(
      findMcpTool("get_boq_variance", ["pos.read", "pos.write"], undefined, LEGACY_GRANTS, {
        industry: "food_service",
      }),
    ).toBeNull();
  });

  it("advertised modules match the exact module predicate used by mcpToolCatalogue", () => {
    const options = { industry: "food_service" as const, writeMode: "approve" as const };
    const modules = new Set(
      mcpAvailableModules(["pos.read", "pos.write"], undefined, LEGACY_GRANTS, options),
    );
    const tools = mcpToolCatalogue(["pos.read", "pos.write"], undefined, LEGACY_GRANTS, options);
    for (const tool of tools) {
      if (tool.binding.kind === "read") {
        expect(modules.has(mcpModuleForReadTool(tool.binding.readToolName))).toBe(true);
      } else if (tool.binding.kind === "write") {
        expect(modules.has(mcpModuleForWriteAction(tool.binding.actionType))).toBe(true);
      }
    }
    // Narrowing to CRM read-only narrows both advertised modules and tools
    const crmOnly = parseMcpGrants({
      apps: { crm: { read: true, write: false } },
      branches: "all",
    });
    const crmModules = mcpAvailableModules(["pos.read", "pos.write"], undefined, crmOnly, options);
    expect(crmModules).toEqual(["customers", "crm", "loyalty"]);
  });
});

describe("P3: JSON Schema portability (no array-typed nullable fields)", () => {
  it("uses anyOf rather than array type across every tool inputSchema", () => {
    const tools = mcpToolCatalogue(["pos.read", "pos.write"]);
    const offending: string[] = [];
    function check(node: unknown, path: string) {
      if (!node || typeof node !== "object") return;
      const rec = node as Record<string, unknown>;
      if (Array.isArray(rec.type)) {
        offending.push(`${path}: type=${JSON.stringify(rec.type)}`);
      }
      if (rec.properties && typeof rec.properties === "object") {
        for (const [k, v] of Object.entries(rec.properties as Record<string, unknown>)) {
          check(v, `${path}.${k}`);
        }
      }
      if (rec.items) check(rec.items, `${path}[]`);
      if (Array.isArray(rec.anyOf)) {
        rec.anyOf.forEach((b, i) => check(b, `${path}.anyOf[${i}]`));
      }
    }
    for (const tool of tools) {
      check(tool.descriptor.inputSchema, tool.descriptor.name);
    }
    expect(offending).toEqual([]);
  });
});

describe("P2: cursor pagination and concise single-line descriptions", () => {
  it("keeps every tool description to a single line and reduces total food_service payload well below 341 KB", () => {
    const tools = mcpToolCatalogue(
      ["pos.read", "pos.write"],
      undefined,
      LEGACY_GRANTS,
      { industry: "food_service", writeMode: "approve" },
    ).map((t) => t.descriptor);
    for (const tool of tools) {
      expect(tool.description.includes("\n"), `${tool.name} has multi-line description`).toBe(
        false,
      );
    }
    const totalBytes = JSON.stringify({ tools }).length;
    expect(totalBytes).toBeLessThan(260_000);

    // Follow nextCursor across all pages: every tool seen exactly once
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = paginateMcpTools(tools, cursor);
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      expect(page.tools.length).toBeLessThanOrEqual(MCP_TOOLS_PAGE_SIZE);
      seen.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(tools.map((t) => t.name));
    expect(new Set(seen).size).toBe(tools.length);
  });

  it("rejects malformed cursors", () => {
    const tools = mcpReadTools().map((t) => t.descriptor);
    expect(paginateMcpTools(tools, "not-a-valid-cursor")).toEqual({ ok: false });
  });
});

describe("P4: write tool descriptions and annotations match approval semantics", () => {
  it("states approval queue semantics on approve-mode connections and marks queued writes non-destructive", () => {
    const approveTools = mcpToolCatalogue(
      ["pos.write"],
      undefined,
      LEGACY_GRANTS,
      { writeMode: "approve" },
    ).filter((t) => t.binding.kind === "write");
    expect(approveTools.length).toBe(mcpWriteTools().length);
    for (const tool of approveTools) {
      expect(tool.descriptor.description).toMatch(/approval|تأیید/);
      expect(tool.descriptor.description).not.toMatch(/in one transaction|در یک تراکنش/);
      expect(tool.descriptor.annotations.destructiveHint).toBe(false);
      expect(tool.descriptor.annotations.readOnlyHint).toBe(false);
    }
  });

  it("distinguishes immediate apply writes from always_approve step-up writes on apply-mode connections", () => {
    const applyTools = mcpToolCatalogue(
      ["pos.write"],
      undefined,
      LEGACY_GRANTS,
      { writeMode: "apply" },
    );
    const expense = applyTools.find((t) => t.descriptor.name === "write_expense")!;
    // expense.create is always_approve -> still awaits human approval even in apply mode
    expect(expense.descriptor.description).toContain("Always awaits human approval");
    expect(expense.descriptor.annotations.destructiveHint).toBe(false);

    const accountDelete = applyTools.find((t) => t.descriptor.name === "write_account_delete")!;
    // account.delete is mode-governed and destructive -> applies immediately in apply mode
    expect(accountDelete.descriptor.description).toContain("Applies immediately");
    expect(accountDelete.descriptor.annotations.destructiveHint).toBe(true);
  });
});
