/**
 * GH #1567 F7 — the policy's invariants, so a new AI verb cannot silently
 * land on the "applies immediately" side and no AI path can reach an
 * executor without passing the approval boundary.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, type ActionType } from "./ai";
import { aiActionPermission } from "./ai-capabilities";
import { evaluateAutopilotProposal, evaluateUnattendedAction } from "./ai-autopilot";
import { MCP_WRITE_REGISTRY, mcpWriteRegistryEntry } from "./mcp/registry";
import {
  AI_APPROVAL_CLASSES,
  AI_APPROVAL_EXEMPT,
  AI_APPROVAL_FINANCIAL_PERMISSIONS,
  AI_HUMAN_APPROVAL_ACTIONS,
  aiApprovalClass,
  requiresHumanApproval,
} from "./ai-approval-policy";
import { aiApprovalPayloadHash } from "./ai-approval-hash";

const executable = (Object.keys(ACTION_CATALOG) as ActionType[]).filter((type) => Boolean(ACTION_CATALOG[type].executor));

describe("F7 approval classification", () => {
  it("classifies only real executor-backed actions, and the registry agrees", () => {
    for (const [type, cls] of Object.entries(AI_HUMAN_APPROVAL_ACTIONS)) {
      expect(ACTION_CATALOG[type as ActionType]?.executor, type).toBeTruthy();
      expect(AI_APPROVAL_CLASSES).toContain(cls);
      const entry = mcpWriteRegistryEntry(type);
      if (entry) {
        // Coworker-only actions (inventory.waste.log) have no MCP entry.
        expect({ type, risk: entry.risk, approval: entry.approval }).toEqual({ type, risk: "high", approval: "always_approve" });
      }
    }
  });

  it("every always_approve verb is high risk and gated", () => {
    for (const entry of MCP_WRITE_REGISTRY) {
      if (entry.approval === "always_approve") {
        expect({ a: entry.actionType, risk: entry.risk }).toEqual({ a: entry.actionType, risk: "high" });
        expect(requiresHumanApproval(entry.actionType)).toBe(true);
      }
    }
  });

  it("every executor-backed verb carrying a financial/stock permission is gated or exempted with a reason", () => {
    const unclassified: string[] = [];
    let checked = 0;
    for (const type of executable) {
      const permission = aiActionPermission(type);
      if (!permission || !AI_APPROVAL_FINANCIAL_PERMISSIONS.has(permission)) continue;
      checked += 1;
      if (requiresHumanApproval(type)) continue;
      if (Object.prototype.hasOwnProperty.call(AI_APPROVAL_EXEMPT, type)) continue;
      unclassified.push(`${type} (${permission})`);
    }
    expect(unclassified).toEqual([]);
    // The rule really bites: well over a hundred money/stock verbs today.
    expect(checked).toBeGreaterThan(100);
  });

  it("exemptions name real, ungated actions with a reason", () => {
    for (const [type, exemption] of Object.entries(AI_APPROVAL_EXEMPT)) {
      expect(ACTION_CATALOG[type as ActionType], type).toBeTruthy();
      expect(requiresHumanApproval(type), type).toBe(false);
      expect(exemption.note.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("covers the six owner-named classes across trades", () => {
    expect(aiApprovalClass("fashion_apparel.item.sell")).toBe("sale");
    expect(aiApprovalClass("order.create")).toBe("sale");
    expect(aiApprovalClass("wholesale.stock.update")).toBe("stock");
    expect(aiApprovalClass("inventory.waste.log")).toBe("stock");
    expect(aiApprovalClass("purchase.lifecycle")).toBe("purchase");
    expect(aiApprovalClass("cheque.create")).toBe("payment");
    expect(requiresHumanApproval("purchase.receive")).toBe(true);
    expect(requiresHumanApproval("order.return.create")).toBe(true);
    expect(requiresHumanApproval("expense.categorize")).toBe(true);
    expect(requiresHumanApproval("inventory.production.run")).toBe(true);
    // Read-only / draft / master data stay ungated.
    expect(requiresHumanApproval("inventory.reorder.draftPO")).toBe(false);
    expect(requiresHumanApproval("journal.manual.propose")).toBe(false);
    expect(requiresHumanApproval("fashion_apparel.item.create")).toBe(false);
    expect(requiresHumanApproval("menu.item.priceUpdate")).toBe(false);
  });
});

describe("F7 unattended deciders", () => {
  const setting = { enabled: true, maxAmountRial: 1e12, maxPercent: 100, maxItemsPerRun: 100, dailyActionLimit: 100 };
  it("never auto-applies a gated action, whatever the caps say", () => {
    for (const type of executable) {
      if (!requiresHumanApproval(type)) continue;
      const meta = ACTION_CATALOG[type];
      expect(
        evaluateAutopilotProposal({ meta, payload: {}, setting, appliedTodayInCategory: 0, context: {} }),
      ).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
      expect(
        evaluateUnattendedAction({
          meta, payload: {}, approvalMode: "auto", hasAuthorizer: true, setting, appliedTodayInCategory: 0, context: {},
        }),
      ).toMatchObject({ decision: "needs_confirmation", reasonCode: "human_approval_required" });
    }
  });
});

describe("F7 payload binding", () => {
  it("is key-order independent and changes with any value", () => {
    const a = aiApprovalPayloadHash("order.create", { a: 1, b: { c: [1, 2], d: "x" } });
    const b = aiApprovalPayloadHash("order.create", { b: { d: "x", c: [1, 2] }, a: 1 });
    expect(a).toBe(b);
    expect(aiApprovalPayloadHash("order.create", { a: 2, b: { c: [1, 2], d: "x" } })).not.toBe(a);
    expect(aiApprovalPayloadHash("order.discount.apply", { a: 1, b: { c: [1, 2], d: "x" } })).not.toBe(a);
  });
});

describe("F7 single executor boundary", () => {
  it("no module reaches AUTOPILOT_EXECUTORS except the approval boundary", () => {
    const root = path.join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const text = readFileSync(full, "utf8");
        if (/AUTOPILOT_EXECUTORS\s*\[/.test(text)) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(["lib/ai-human-approval.ts"]);
  });
});
