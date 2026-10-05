import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routeTools, isAlwaysOnTool, appForTool } from "./ai-tool-routing";

describe("isAlwaysOnTool", () => {
  it("marks the tools that Phase 33 rules depend on as always-on", () => {
    expect(isAlwaysOnTool("find_items")).toBe(true);
    expect(isAlwaysOnTool("describe_app")).toBe(true);
    expect(isAlwaysOnTool("propose_action")).toBe(true);
    expect(isAlwaysOnTool("list_reports")).toBe(true);
    expect(isAlwaysOnTool("run_report")).toBe(true);
  });

  it("does not mark app-specific tools as always-on", () => {
    expect(isAlwaysOnTool("get_menu_performance")).toBe(false);
    expect(isAlwaysOnTool("get_ar_aging")).toBe(false);
    expect(isAlwaysOnTool("get_courier_performance")).toBe(false);
  });
});

describe("appForTool", () => {
  it("maps app-specific tools to their owning app", () => {
    expect(appForTool("get_menu_performance")).toBe("accounting");
    expect(appForTool("get_repurchase_candidates")).toBe("growth");
    expect(appForTool("get_reservation_conflicts")).toBe("accounting");
    expect(appForTool("get_ar_aging")).toBe("accounting");
  });

  it("returns null for always-on and general-purpose tools", () => {
    expect(appForTool("find_items")).toBeNull();
    expect(appForTool("describe_app")).toBeNull();
    expect(appForTool("propose_action")).toBeNull();
  });
});

describe("routeTools", () => {
  const allTools = [
    "find_items",
    "describe_app",
    "propose_action",
    "list_reports",
    "run_report",
    "get_menu_performance",
    "get_void_pattern",
    "get_waste_history",
    "get_repurchase_candidates",
    "get_staff_commission",
    "get_reservation_conflicts",
    "get_courier_performance",
    "get_ar_aging",
    "get_ap_upcoming",
    "draft_expense_from_receipt",
    "get_bill_split_preview",
    "run_accounting_review",
  ];

  it("returns null when no apps are specified (uncertain → send everything)", () => {
    expect(routeTools(allTools, null)).toBeNull();
    expect(routeTools(allTools, undefined)).toBeNull();
    expect(routeTools(allTools, [])).toBeNull();
  });

  it("includes always-on tools regardless of apps", () => {
    const result = routeTools(allTools, ["accounting"])!;
    expect(result).toContain("find_items");
    expect(result).toContain("describe_app");
    expect(result).toContain("propose_action");
    expect(result).toContain("list_reports");
    expect(result).toContain("run_report");
  });

  it("includes sales, operations and ledger tools for Accounting", () => {
    const accounting = routeTools(allTools, ["accounting"])!;
    expect(accounting).toContain("get_menu_performance");
    expect(accounting).toContain("get_reservation_conflicts");
    expect(accounting).toContain("get_ar_aging");
    expect(accounting).not.toContain("get_repurchase_candidates");
  });

  it("includes tools from multiple apps when multiple are in scope", () => {
    const result = routeTools(allTools, ["accounting", "growth"])!;
    expect(result).toContain("get_menu_performance");
    expect(result).toContain("get_ar_aging");
    expect(result).toContain("get_repurchase_candidates");
  });

  it("includes general-purpose tools (not in map) always", () => {
    const toolsWithGeneral = [...allTools, "some_unknown_tool"];
    const result = routeTools(toolsWithGeneral, ["accounting"])!;
    expect(result).toContain("some_unknown_tool");
  });

  it("produces fewer tools for a single-app turn than the full set", () => {
    const full = routeTools(allTools, ["accounting", "growth", "crm", "website"])!;
    const single = routeTools(allTools, ["accounting"])!;
    expect(single.length).toBeLessThan(full.length);
  });
});

/**
 * Issue #812 §11 — "App Focus actually narrows the live tool catalogue".
 *
 * `routeTools` above was pure and tested and had **zero callers** until this
 * issue wired it into `runAgentTurn`. That is the failure mode this block
 * guards: a narrowing function nobody calls is a narrowing that does not
 * happen, and the exit criterion is phrased in terms of the live catalogue
 * precisely because a prompt line asking the model to focus is guidance it may
 * ignore.
 */
describe("issue #812 §11 — App Focus narrows the live catalogue", () => {
  const ALL = [
    "find_items",
    "describe_app",
    "propose_action",
    "list_reports",
    "run_report",
    "get_menu_performance",
    "get_ar_aging",
    "get_repurchase_candidates",
    "get_customer_profile",
  ];

  it("drops other apps' tools while keeping the always-on set", () => {
    const routed = routeTools(ALL, ["accounting"]);
    expect(routed).not.toBeNull();
    const names = routed!;
    // Accounting's own tools survive.
    expect(names).toContain("get_menu_performance");
    expect(names).toContain("get_ar_aging");
    // Other apps' tools are gone — this is the narrowing, and it is a fact the
    // model cannot argue with rather than a request it may decline.
    expect(names).not.toContain("get_repurchase_candidates");
    expect(names).not.toContain("get_customer_profile");

    // The always-on set survives, because Phase 33's "before you say something
    // doesn't exist, call describe_app" depends on it.
    for (const alwaysOn of ["find_items", "describe_app", "propose_action", "list_reports", "run_report"]) {
      expect(names, alwaysOn).toContain(alwaysOn);
    }
  });

  it("leaves the website app unmapped rather than guessing", () => {
    // An honest limitation of the map, recorded so nobody mistakes it for the
    // mechanism working: no tool in the catalogue is mapped to `website`, so
    // focusing a turn on Website narrows to the always-on set plus every
    // unmapped tool. The narrowing is therefore weaker for that app than for
    // the other three. Adding the website tools to `TOOL_APP_MAP` is the fix,
    // and it is a data fix, not a code one — the mechanism works.
    const routed = routeTools(ALL, ["website"]);
    expect(routed).not.toBeNull();
    for (const name of ALL) {
      const owning = appForTool(name);
      if (owning && owning !== "website") {
        expect(routed!, name).not.toContain(name);
      }
    }
  });

  it("returns null for no focus, so an unfocused turn is unchanged", () => {
    // The compatibility requirement: a turn with no app context must send
    // exactly what it sent before this issue. `null` is how `runAgentTurn`
    // knows to skip the step entirely rather than route against an empty set.
    expect(routeTools(ALL, null)).toBeNull();
    expect(routeTools(ALL, undefined)).toBeNull();
    expect(routeTools(ALL, [])).toBeNull();
  });

  it("is reachable from the live turn, not only from tests", () => {
    // The whole point. `routeTools` existed, was pure, was tested, and nothing
    // called it — so App Focus was a prompt line and nothing more. This reads
    // the two files that close that gap.
    const service = readFileSync("src/lib/ai-service.ts", "utf8");
    expect(service, "runAgentTurn must import the router").toMatch(/import \{ routeTools \} from "\.\/ai-tool-routing"/);
    expect(service, "runAgentTurn must apply the app focus").toMatch(/routeTools\(/);
    expect(service, "and must accept the focus as an option").toMatch(/appFocus\?: AppKey \| null/);

    const route = readFileSync("src/app/api/ai/chat/route.ts", "utf8");
    expect(route, "the chat route must pass the focused app through").toMatch(/appFocus: focusedApp/);
  });

  it("does not treat «workspace» as an app", () => {
    // `apps.ts` has four apps. «workspace» is a work area inside Accounting, so
    // a project turn stays Accounting-scoped and must not narrow to a fifth app
    // that does not exist.
    const route = readFileSync("src/app/api/ai/chat/route.ts", "utf8");
    expect(route).toMatch(/APP_KEYS\.includes\(appFocus as AppKey\)/);
    // Each real app routes; «workspace» is not one of them, so the route's own
    // `APP_KEYS.includes(...)` guard is what keeps a project turn from being
    // narrowed against a fifth app that does not exist.
    for (const app of ["accounting", "growth", "crm", "website"]) {
      expect(routeTools(ALL, [app]), app).not.toBeNull();
    }
    expect(["accounting", "growth", "crm", "website"]).not.toContain("workspace");
  });
});
