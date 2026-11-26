/**
 * Issue #1546 — the tool catalogue a turn sends.
 *
 * The reported prompt cost was ~45k–54k tokens per provider call, with an
 * estimated 29k of it tool schemas. The fix is not "send fewer tools because it
 * is faster": it is "send the sections this turn is actually about, keep the
 * always-on set, and widen again whenever the member's own words cross an app
 * boundary".
 *
 * These tests measure the real catalogue with the same estimator the billing
 * ledger uses, so the ≥50% acceptance criterion is a number this suite computes
 * rather than a claim in a description.
 */
import { describe, expect, it, vi } from "vitest";
import { toolDefinitions } from "./ai";
import { estimateTokens } from "./ai-billing";
import { filterAiToolsByPermissions } from "./ai-capabilities";
import { ALL_PERMISSIONS, PERMISSIONS } from "./permissions";
import { appForTool, groupsMentionedIn, isAlwaysOnTool, routeTools, toolGroupOf } from "./ai-tool-routing";
import { selectAiTools, type AiToolSelectionContext } from "./ai-tool-selection";
import { toolMetadata } from "./ai-tool-metadata";
import { sdkToolsFromSelection } from "./ai-sdk-adapter";

const TOOL_OPTIONS = {
  browserNavigation: true,
  retrieval: true,
  hasAttachment: true,
} as const;

function catalogue() {
  const tools = toolDefinitions("dashboard", TOOL_OPTIONS);
  return { tools, names: tools.map((tool) => tool.function.name) };
}

function tokensFor(names: readonly string[]): number {
  const { tools } = catalogue();
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  return estimateTokens(JSON.stringify(names.map((name) => byName.get(name)).filter(Boolean)));
}

describe("issue #1546 — app-focused turns send ≥50% fewer schema tokens", () => {
  const cases = [
    { label: "accounting / sales", app: "accounting" as const, message: "چقدر دیروز فروختیم؟" },
    { label: "accounting / inventory", app: "accounting" as const, message: "موجودی انبار و ضایعات این ماه چقدر است؟" },
    { label: "accounting / ledger", app: "accounting" as const, message: "مانده حساب مشتریان و مالیات ارزش افزوده چقدر است؟" },
    { label: "crm", app: "crm" as const, message: "مشتری‌های در معرض ریزش را نشان بده" },
    { label: "growth", app: "growth" as const, message: "کمپین پیامکی بازگشت مشتری چطور بود؟" },
    { label: "website", app: "website" as const, message: "وضعیت سایت و نوشته‌های منتشرشده" },
  ];

  const baseline = (() => {
    const { tools } = catalogue();
    return estimateTokens(JSON.stringify(tools));
  })();

  it("records a baseline consistent with the reported ~29k-token schema overhead", () => {
    // The issue reports ~29k tokens for 144 tools from LiteLLM's own count; the
    // app's estimator is deliberately conservative (chars/2), so it lands
    // slightly above that. Both numbers describe the same problem.
    expect(baseline).toBeGreaterThan(25_000);
  });

  it.each(cases)("$label keeps at least half the schema cost out of the prompt", ({ app, message }) => {
    const { names } = catalogue();
    const routed = routeTools(names, [app], { message });
    expect(routed).not.toBeNull();

    const after = tokensFor(routed!);
    const reduction = 1 - after / baseline;
    // Printed so `docs/ai/latency-1546.md` can be reproduced with one command.
    console.log(
      `schema budget ${app} (${message.slice(0, 24)}…): ${routed!.length} tools, ` +
        `${after} of ${baseline} tokens, ${(reduction * 100).toFixed(1)}% fewer`,
    );
    expect(reduction, `${app}: ${after} of ${baseline} tokens`).toBeGreaterThanOrEqual(0.5);
  });

  it("a cross-app multi-tool turn keeps every named app and is still smaller than baseline", () => {
    // This turn is deliberately NOT app-focused — it names three apps — so it is
    // not held to the 50% criterion. What it must do is keep all three apps'
    // tools (task success) while still cutting the untargeted remainder.
    const { names } = catalogue();
    const routed = routeTools(names, ["accounting"], {
      message: "فروش دیروز و مشتری‌های سایت را مقایسه کن و موجودی انبار را هم بگو",
    })!;
    for (const name of ["get_menu_performance", "find_customers", "list_website_posts", "get_stock_valuation"]) {
      expect(routed, name).toContain(name);
    }
    const after = tokensFor(routed);
    console.log(
      `schema budget cross-app multi-tool: ${routed.length} tools, ${after} of ${baseline} tokens, ` +
        `${((1 - after / baseline) * 100).toFixed(1)}% fewer`,
    );
    expect(after).toBeLessThan(baseline);
  });

  it("keeps the always-on set and the registry-independent fallback intact", () => {
    const { names } = catalogue();
    const routed = routeTools(names, ["crm"], { message: "مشتری‌ها" })!;
    for (const name of names) {
      if (isAlwaysOnTool(name)) expect(routed, name).toContain(name);
      // A tool nobody classified must never be filtered away.
      if (!toolGroupOf(name) && !isAlwaysOnTool(name)) expect(routed, name).toContain(name);
    }
  });
});

describe("issue #1546 — selection is section-aware but fail-open", () => {
  it("keeps every section of the focused app when the turn names no section", () => {
    const { names } = catalogue();
    const routed = routeTools(names, ["accounting"], { message: "دیروز چطور بود؟" })!;
    // All six Accounting sections survive a vague turn…
    for (const group of [
      "accounting:sales",
      "accounting:inventory",
      "accounting:ledger",
      "accounting:payroll",
      "accounting:projects",
      "accounting:workspace",
    ]) {
      expect(
        routed.some((name) => toolGroupOf(name) === group),
        group,
      ).toBe(true);
    }
    // …and other apps' sections do not.
    expect(routed).not.toContain("find_customers");
    expect(routed).not.toContain("list_website_posts");
  });

  it("uses the existing task lens as a hint without a model call", () => {
    const { names } = catalogue();
    const routed = routeTools(names, ["accounting"], { task: "sales", message: null })!;
    expect(routed).toContain("get_menu_performance");
    expect(routed).toContain("list_orders");
    expect(routed).not.toContain("get_payroll_summary");
    expect(routed).not.toContain("get_waste_history");
  });

  it("expands across apps when the member's own words name another app", () => {
    const { names } = catalogue();
    const routed = routeTools(names, ["accounting"], {
      message: "فروش دیروز را با مشتری‌های سایت مقایسه کن",
    })!;
    expect(routed).toContain("get_menu_performance");
    expect(routed).toContain("find_customers");
    expect(routed).toContain("list_website_posts");
  });

  it("still returns null with no app focus, so an unfocused turn is unchanged", () => {
    const { names } = catalogue();
    expect(routeTools(names, null, { message: "چقدر فروختیم؟" })).toBeNull();
    expect(routeTools(names, [])).toBeNull();
  });

  it("recognises Persian and English section words", () => {
    expect(groupsMentionedIn("فروش دیروز")).toContain("accounting:sales");
    expect(groupsMentionedIn("inventory report")).toContain("accounting:inventory");
    expect(groupsMentionedIn("سلام")).toEqual([]);
  });
});

describe("issue #1546 — routing never grants anything", () => {
  it("cannot widen a member's permissions: the permission filter still applies after routing", () => {
    const { tools, names } = catalogue();
    const routed = routeTools(names, ["accounting"], { message: "فروش" })!;
    const offered = tools.filter((tool) => routed.includes(tool.function.name));
    // A member who may only use the assistant sees the protocol tools and
    // nothing else, whatever the router offered.
    const permitted = filterAiToolsByPermissions(offered, new Set([PERMISSIONS.aiUse]));
    const permittedNames = permitted.map((tool) => tool.function.name);
    expect(permittedNames).toContain("propose_action");
    expect(permittedNames).not.toContain("get_menu_performance");
  });

  it("keeps the existing app ownership answers", () => {
    expect(appForTool("get_menu_performance")).toBe("accounting");
    expect(appForTool("get_repurchase_candidates")).toBe("growth");
    expect(appForTool("find_customers")).toBe("crm");
    expect(appForTool("list_website_posts")).toBe("website");
    expect(appForTool("find_items")).toBeNull();
    expect(appForTool("something_not_classified")).toBeNull();
  });
});

describe("issue #1546 Phase 2 — context-aware selection", () => {
  const fullPermissions = new Set(ALL_PERMISSIONS);
  function select(overrides: Partial<AiToolSelectionContext> = {}) {
    return selectAiTools({
      catalogue: catalogue().tools,
      permissions: fullPermissions,
      workspaceAvailable: true,
      retrieval: true,
      browserNavigation: true,
      hasAttachment: true,
      ...overrides,
    });
  }
  const baseline = estimateTokens(JSON.stringify(catalogue().tools));

  it("uses the current page as a default without ever treating it as a grant", () => {
    const result = select({ routeApp: "accounting", message: "دیروز چطور بود؟" });
    expect(result.diagnostics.source).toBe("route_hint");
    expect(result.diagnostics.ambiguous).toBe(false);
    expect(result.diagnostics.schemaTokens).toBeLessThan(baseline);
    // The focused app keeps every section when no section was named.
    for (const group of [
      "accounting:sales",
      "accounting:inventory",
      "accounting:ledger",
      "accounting:payroll",
      "accounting:projects",
      "accounting:workspace",
    ]) {
      expect(result.tools.some((tool) => toolGroupOf(tool.function.name) === group), group).toBe(true);
    }
    // Other apps are not offered just because the page is Accounting.
    expect(result.tools.map((tool) => tool.function.name)).not.toContain("find_customers");
  });

  it("still narrows an app-focused sales question by at least half", () => {
    const result = select({ appFocus: "accounting", message: "چقدر دیروز فروختیم؟" });
    expect(result.diagnostics.reductionPct).toBeGreaterThanOrEqual(50);
    expect(result.diagnostics.schemaTokens).toBeLessThanOrEqual(baseline * 0.5);
    expect(result.tools.map((tool) => tool.function.name)).toContain("get_menu_performance");
    expect(result.tools.map((tool) => tool.function.name)).not.toContain("find_customers");
  });

  it("keeps a safe full fallback for an ambiguous request with no app context", () => {
    const result = select({ message: "سلام" });
    expect(result.diagnostics.source).toBe("no_context");
    expect(result.diagnostics.ambiguous).toBe(true);
    expect(result.tools).toHaveLength(catalogue().tools.length);
    expect(result.diagnostics.schemaTokens).toBe(baseline);
  });

  it("does not offer tools from a disabled app", () => {
    const result = select({
      appFocus: "website",
      enabledApps: ["accounting", "crm", "growth"],
      message: "وضعیت سایت",
    });
    const names = result.tools.map((tool) => tool.function.name);
    expect(names).not.toContain("list_website_posts");
    expect(names).not.toContain("get_website_status");
    expect(result.diagnostics.excluded.some((row) => row.group === "website:content" && row.reason === "app_disabled")).toBe(true);
    // The always-on/shared safety surface survives.
    expect(names).toContain("describe_app");
    expect(names).toContain("propose_action");
  });

  it("does not offer a section whose feature is disabled", () => {
    const result = select({
      appFocus: "accounting",
      enabledFeatures: {
        inventory: false,
        stock: false,
        ledger: true,
        accounting: true,
        reporting: true,
        crm: true,
        growth: true,
        website: true,
        reservations: true,
        delivery: true,
        workspace: true,
      },
      message: "موجودی انبار و ضایعات این ماه",
    });
    const names = result.tools.map((tool) => tool.function.name);
    expect(names).not.toContain("get_stock_valuation");
    expect(names).not.toContain("get_waste_history");
    expect(result.diagnostics.excluded.some((row) => row.group === "accounting:inventory" && row.reason === "feature_disabled")).toBe(true);
  });

  it("keeps business-wide reads out of a branch-scoped member's offer", () => {
    const result = select({ appFocus: "accounting", branchScope: "selected", message: "دیروز چطور بود؟" });
    expect(result.tools.map((tool) => tool.function.name)).not.toContain("get_branch_comparison");
    expect(result.diagnostics.excluded.some((row) => row.reason === "dependency_unmet")).toBe(true);
    expect(result.diagnostics.branchScope).toBe("selected");
  });

  it("adds the project workspace and keeps AEC only for the construction industry", () => {
    const crmProject = select({
      appFocus: "crm",
      projectScoped: true,
      industry: "food_service",
      message: "دیروز چطور بود؟",
    });
    const crmNames = crmProject.tools.map((tool) => tool.function.name);
    expect(crmNames).toContain("get_workspace_dashboard");
    expect(crmNames).toContain("find_customers");
    expect(crmNames).not.toContain("get_boq_variance");

    const aecProject = select({
      appFocus: "accounting",
      projectScoped: true,
      industry: "architecture_construction",
      message: "وضعیت پروژه",
    });
    expect(aecProject.tools.map((tool) => tool.function.name)).toContain("get_boq_variance");
  });

  it("uses an assigned agent's app focus and allowlist as narrowing inputs", () => {
    const result = select({
      agentApp: "crm",
      agentAllowedTools: ["find_customers", "get_customer_profile"],
      message: "مشتری‌ها",
    });
    expect(result.diagnostics.source).toBe("agent_focus");
    expect(result.diagnostics.agentScoped).toBe(true);
    const names = result.tools.map((tool) => tool.function.name);
    expect(names).toContain("find_customers");
    expect(names).toContain("get_customer_profile");
    expect(names).not.toContain("get_menu_performance");
    expect(names).toContain("propose_action");
  });

  it("adds every named cross-app group without dropping the focused app", () => {
    const result = select({ appFocus: "accounting", message: "مشتری‌های سایت" });
    const names = result.tools.map((tool) => tool.function.name);
    expect(names).toContain("get_menu_performance");
    expect(names).toContain("find_customers");
    expect(names).toContain("list_website_posts");
  });

  it("keeps the focused app whole on a follow-up that names no section", () => {
    const first = select({ appFocus: "accounting", message: "فروش دیروز چطور بود؟" });
    const followUp = select({ appFocus: "accounting", message: "و دیروز؟" });
    expect(first.tools.map((tool) => tool.function.name)).toContain("get_menu_performance");
    for (const name of ["get_menu_performance", "get_stock_valuation", "get_ar_aging"]) {
      expect(followUp.tools.map((tool) => tool.function.name), name).toContain(name);
    }
  });

  it("applies permissions after selection and records the reason", () => {
    const result = select({ appFocus: "accounting", message: "فروش", permissions: new Set([PERMISSIONS.aiUse]) });
    const names = result.tools.map((tool) => tool.function.name);
    expect(names).not.toContain("get_menu_performance");
    expect(names).toContain("propose_action");
    expect(result.diagnostics.excluded.some((row) => row.reason === "permission")).toBe(true);
  });

  it("adds no provider call and exposes no prompt, argument or record in diagnostics", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sentinel = "این جمله نباید در تشخیص‌ها بیاید";
    const result = select({ appFocus: "crm", message: sentinel });
    expect(fetchMock).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("biz-1");
    expect(serialized).not.toContain("user-1");
  });

  it("reuses the same declarations through the SDK adapter", () => {
    const selected = select({ appFocus: "accounting", message: "چقدر دیروز فروختیم؟" });
    const sdk = sdkToolsFromSelection(
      {
        catalogue: catalogue().tools,
        permissions: fullPermissions,
        workspaceAvailable: true,
        appFocus: "accounting",
        message: "چقدر دیروز فروختیم؟",
      },
      async () => "{}",
    );
    expect(Object.keys(sdk.tools).sort()).toEqual(selected.tools.map((tool) => tool.function.name).sort());
    expect(sdk.diagnostics.schemaTokens).toBe(selected.diagnostics.schemaTokens);
  });
});

describe("issue #1546 Phase 2 — tool metadata", () => {
  it("maps every catalogue tool, with a permission for everything except the protocol", () => {
    for (const tool of catalogue().tools) {
      const metadata = toolMetadata(tool.function.name);
      if (tool.function.name === "propose_action" || tool.function.name === "request_input") {
        expect(metadata.permission, tool.function.name).toBeNull();
      } else {
        expect(metadata.permission, tool.function.name).not.toBeNull();
      }
    }
  });

  it("derives app, task, feature and dependency facts from the one catalogue", () => {
    const sales = toolMetadata("get_menu_performance");
    expect(sales.app).toBe("accounting");
    expect(sales.tasks).toContain("sales");
    expect(toolMetadata("get_branch_comparison").dependencies).toContain("branchWide");
    expect(toolMetadata("get_boq_variance").dependencies).toEqual(expect.arrayContaining(["workspace", "aecIndustry"]));
    expect(toolMetadata("get_reservation_conflicts").features).toContain("reservations");
    expect(toolMetadata("search_business_knowledge").permission).toBe(PERMISSIONS.aiUse);
  });
});
