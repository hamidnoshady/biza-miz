/**
 * Issue #883 — CI parity enforcement: the registry must name every verb the
 * MCP surface supports, and nothing else. Drift in either direction is a CI
 * failure before release, not a reviewer catching it later.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, toolDefinitions, type ActionType } from "../ai";
import { AI_ACTION_PERMISSION_MAP, AI_TOOL_PERMISSION_MAP } from "../ai-capabilities";
import { buildMcpVerbInventory } from "./verb-inventory";
import {
  MCP_READ_REGISTRY,
  MCP_WRITE_REGISTRY,
  mcpBusinessWideToolAllowed,
  mcpReadRegistryEntry,
  mcpRegistryEntryForResource,
  mcpWriteRegistryEntry,
} from "./registry";
import { mcpReadTools, mcpWriteTools, mcpToolCatalogue, assertWriteToolsMatchCatalogue } from "./tools";
import { MCP_RESOURCES } from "./resources";
import { MCP_APPS, LEGACY_GRANTS, parseMcpGrants } from "./grants";
import { AUTOPILOT_EXECUTORS } from "../ai-autopilot-executors";

describe("read registry", () => {
  it("names every read tool the catalogue exposes — no more, no fewer", () => {
    const catalogueNames = new Set(
      mcpReadTools().map((tool) => tool.descriptor.name),
    );
    const registryNames = new Set(MCP_READ_REGISTRY.map((entry) => entry.name));
    expect(registryNames).toEqual(catalogueNames);
  });

  it("has no duplicate entries", () => {
    const names = MCP_READ_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry picks a real app and a real branch policy", () => {
    for (const entry of MCP_READ_REGISTRY) {
      expect(MCP_APPS).toContain(entry.app);
      expect(["agnostic", "business_wide", "pinned"]).toContain(entry.branchPolicy);
    }
  });

  it("every read tool the assistant knows a permission for IS in the registry (nothing admin-only sneaks through)", () => {
    const catalogueNames = new Set(mcpReadTools().map((tool) => tool.descriptor.name));
    // Every exposed read tool has an explicit permission map entry AND registry entry.
    for (const name of catalogueNames) {
      expect(
        AI_TOOL_PERMISSION_MAP[name as keyof typeof AI_TOOL_PERMISSION_MAP],
        `${name} missing from AI_TOOL_PERMISSION_MAP`,
      ).toBeTruthy();
      expect(mcpReadRegistryEntry(name), `${name} missing from registry`).toBeTruthy();
    }
  });

  it("the dashboard description map exposes exactly the registry's surface", () => {
    // toolDefinitions("dashboard") \ EXCLUDED_READ_TOOLS is the read list that
    // MCP serves; the registry mirrors it. This guard fails when someone adds
    // a read tool to ai.ts without registering it HERE — that is issue #883's
    // "a new capability must choose its app/branch/risk tier" rule.
    const exposed = mcpReadTools().map((tool) => tool.descriptor.name).sort();
    const registered = MCP_READ_REGISTRY.map((entry) => entry.name).sort();
    expect(registered).toEqual(exposed);
  });
});

describe("write registry", () => {
  it("names every executable, non-coworker write — the same invariant the catalogue keeps", () => {
    const expected = (Object.keys(ACTION_CATALOG) as ActionType[]).filter((type) => {
      const meta = ACTION_CATALOG[type];
      return Boolean(meta.executor) && !meta.coworkerOnly;
    });
    const registered = MCP_WRITE_REGISTRY.map((entry) => entry.actionType);
    expect(new Set(registered)).toEqual(new Set(expected));
  });

  it("every registered write resolves to a catalogue entry WITH an executor", () => {
    for (const entry of MCP_WRITE_REGISTRY) {
      const meta = ACTION_CATALOG[entry.actionType as ActionType];
      expect(meta, `${entry.actionType} not in ACTION_CATALOG`).toBeTruthy();
      expect(meta.executor!, `${entry.actionType} has no executor`).toBeTruthy();
      expect(
        AUTOPILOT_EXECUTORS[meta.executor!],
        `${entry.actionType} executor ${meta.executor} not implemented`,
      ).toBeTruthy();
    }
  });

  it("every registered write maps to a domain permission", () => {
    for (const entry of MCP_WRITE_REGISTRY) {
      const perm =
        AI_ACTION_PERMISSION_MAP[entry.actionType as keyof typeof AI_ACTION_PERMISSION_MAP];
      expect(perm, `${entry.actionType} missing permission mapping`).toBeTruthy();
    }
  });

  it("the catalogue's own parity check stays green", () => {
    const { missing, extra } = assertWriteToolsMatchCatalogue();
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("only financial-poster writes are marked high-risk, and both of them step up", () => {
    const highRisk = MCP_WRITE_REGISTRY.filter((entry) => entry.risk === "high");
    for (const entry of highRisk) {
      expect(entry.approval).toBe("always_approve");
    }
    // Conversely: a low-risk action must not force approval — accepting
    // step-up for everything would make the apply mode meaningless.
    for (const entry of MCP_WRITE_REGISTRY) {
      if (entry.risk === "low") expect(entry.approval).toBe("mode");
    }
  });

  it("the committed verb inventory matches the registry — regenerate it, do not hand-edit", () => {
    // The inventory is the issue's machine-reviewable acceptance artifact. A
    // reviewer diffing docs/mcp/verb-inventory.md diffing changes to the
    // registry must see them land together; drift means CI, not a missed
    // checklist, says so. Regenerate with `npx tsx scripts/write-mcp-verb-inventory.mts`.
    const committed = readFileSync("docs/mcp/verb-inventory.md", "utf8").replaceAll("\r\n", "\n");
    expect(committed).toBe(buildMcpVerbInventory().replaceAll("\r\n", "\n"));
  });
});

describe("branch policy", () => {
  it("business-wide tools are visible exactly when branch consent covers all branches", () => {
    expect(mcpBusinessWideToolAllowed(true)).toBe(true);
    expect(mcpBusinessWideToolAllowed(false)).toBe(false);
  });

  it("the catalogue hides business-wide tools from a single-branch consent and keeps pinned ones", () => {
    const singleBranch = parseMcpGrants({
      apps: { pos: { read: true, write: false } },
      branches: ["loc-a"],
    });
    const tools = mcpToolCatalogue(["pos.read"], undefined, singleBranch);
    const names = new Set(tools.map((tool) => tool.descriptor.name));
    expect(names.has("get_branch_comparison")).toBe(false);
    expect(names.has("find_items")).toBe(true);
    expect(names.has("run_report")).toBe(true);
  });

  it("legacy consent keeps every business-wide tool — no narrowing by accident", () => {
    const tools = mcpToolCatalogue(["pos.read"], undefined, LEGACY_GRANTS);
    const names = new Set(tools.map((tool) => tool.descriptor.name));
    expect(names.has("get_branch_comparison")).toBe(true);
    expect(names.has("find_items")).toBe(true);
  });

  it("app grants hide a whole domain — including its writes", () => {
    const grants = parseMcpGrants({
      apps: { crm: { read: true, write: false } },
      branches: "all",
    });
    const tools = mcpToolCatalogue(["pos.read", "pos.write"], undefined, grants);
    const names = new Set(tools.map((tool) => tool.descriptor.name));
    expect(names.has("find_customers")).toBe(true);
    expect(names.has("write_customer_note")).toBe(false); // crm.write not granted
    expect(names.has("run_report")).toBe(false); // pos app not granted
    expect(names.has("write_expense")).toBe(false); // accounting app not granted
  });
});

describe("resources", () => {
  it("mcpResourcesFor applies the registry app filter", () => {
    for (const resource of MCP_RESOURCES) {
      // Every tenant-data resource resolves through the registry entry of
      // its underlying tool; only the conventions doc has none.
      if (resource.uri === "pos://app/conventions") {
        expect(mcpRegistryEntryForResource(resource.uri)).toBeNull();
      } else {
        expect(
          mcpRegistryEntryForResource(resource.uri),
          `${resource.uri} has no registry mapping`,
        ).toBeTruthy();
      }
    }
  });
});
