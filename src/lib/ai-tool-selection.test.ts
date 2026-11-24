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
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "./ai";
import { estimateTokens } from "./ai-billing";
import { filterAiToolsByPermissions } from "./ai-capabilities";
import { PERMISSIONS } from "./permissions";
import { appForTool, groupsMentionedIn, isAlwaysOnTool, routeTools, toolGroupOf } from "./ai-tool-routing";

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
