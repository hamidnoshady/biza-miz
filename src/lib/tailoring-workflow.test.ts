import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseAccessPurpose, parseTailoringMeasurements, planTailoringTransition, retentionCutoff,
  type TailoringJobState, type TailoringStatus,
} from "./tailoring-workflow";
import { AI_ACTION_PERMISSION_MAP, AI_TOOL_PERMISSION_MAP, SYSTEM_AI_READ_PERMISSIONS } from "./ai-capabilities";
import { MCP_READ_REGISTRY, MCP_WRITE_REGISTRY } from "./mcp/registry";
import { PERMISSIONS, effectivePermissions } from "./permissions";

const job = (status: TailoringStatus, extra: Partial<TailoringJobState> = {}): TailoringJobState =>
  ({ status, kind: "alteration", estimateRial: BigInt(500_000), orderId: null, ...extra });

describe("GH #1567 6A — tailoring workflow", () => {
  it("walks intake → estimate → approval → fitting → QC → ready → pickup", () => {
    expect(planTailoringTransition(job("intake", { estimateRial: null }), { to: "estimated", estimateRial: BigInt(750_000) }))
      .toMatchObject({ ok: true, plan: { to: "estimated", estimateRial: BigInt(750_000) } });
    expect(planTailoringTransition(job("estimated"), { to: "approved", customerApproved: true })).toMatchObject({ ok: true, plan: { approve: true } });
    expect(planTailoringTransition(job("approved"), { to: "fitting" })).toMatchObject({ ok: true, plan: { fitting: true } });
    expect(planTailoringTransition(job("fitting"), { to: "fitting" })).toMatchObject({ ok: true, plan: { fitting: true } });
    expect(planTailoringTransition(job("fitting"), { to: "qc" })).toMatchObject({ ok: true });
    expect(planTailoringTransition(job("qc"), { to: "ready", qcPassed: true })).toMatchObject({ ok: true });
    expect(planTailoringTransition(job("ready", { orderId: "o" }), { to: "picked_up" })).toMatchObject({ ok: true });
  });

  it("requires an estimate, the customer's explicit approval and a QC outcome", () => {
    expect(planTailoringTransition(job("intake"), { to: "estimated" })).toEqual({ ok: false, error: "tailoring_estimate_required" });
    expect(planTailoringTransition(job("estimated"), { to: "approved" })).toEqual({ ok: false, error: "tailoring_customer_approval_required" });
    expect(planTailoringTransition(job("qc"), { to: "ready" })).toEqual({ ok: false, error: "tailoring_qc_outcome_required" });
    expect(planTailoringTransition(job("qc"), { to: "ready", qcPassed: false })).toEqual({ ok: false, error: "tailoring_transition_invalid" });
  });

  it("a failed QC is rework back to fitting", () => {
    expect(planTailoringTransition(job("qc"), { to: "fitting", qcPassed: false })).toMatchObject({ ok: true, plan: { rework: true, fitting: true } });
  });

  it("an alteration may skip fitting; made-to-measure may not", () => {
    expect(planTailoringTransition(job("approved"), { to: "qc" })).toMatchObject({ ok: true });
    expect(planTailoringTransition(job("approved", { kind: "made_to_measure" }), { to: "qc" }))
      .toEqual({ ok: false, error: "tailoring_fitting_required" });
  });

  it("a priced job is picked up only after its sale (order) is linked; a free one needs none", () => {
    expect(planTailoringTransition(job("ready"), { to: "picked_up" })).toEqual({ ok: false, error: "tailoring_order_required" });
    expect(planTailoringTransition(job("ready", { estimateRial: BigInt(0) }), { to: "picked_up" })).toMatchObject({ ok: true });
  });

  it("refuses jumps, and cancellation after the garment is ready", () => {
    for (const [from, to] of [["intake", "approved"], ["estimated", "fitting"], ["intake", "picked_up"], ["ready", "cancelled"],
      ["picked_up", "intake"], ["cancelled", "intake"]] as [TailoringStatus, TailoringStatus][]) {
      expect(planTailoringTransition(job(from), { to, customerApproved: true, estimateRial: BigInt(1), qcPassed: true }))
        .toEqual({ ok: false, error: "tailoring_transition_invalid" });
    }
    expect(planTailoringTransition(job("fitting"), { to: "cancelled" })).toMatchObject({ ok: true });
  });
});

describe("GH #1567 6A — measurements are minimal", () => {
  it("accepts allow-listed numeric values only", () => {
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: 96.5, waist: 80 } }))
      .toEqual({ ok: true, value: { unit: "cm", values: { chest: 96.5, waist: 80 } } });
  });
  it("refuses unknown keys (no free text or photo field can be smuggled in), bad units, ranges and precision", () => {
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: 96, note: 1 } })).toMatchObject({ ok: false, field: "note" });
    expect(parseTailoringMeasurements({ unit: "cm", values: { photo: 1 } })).toMatchObject({ ok: false, field: "photo" });
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: "96" } })).toMatchObject({ ok: false });
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: 0 } })).toMatchObject({ ok: false });
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: 301 } })).toMatchObject({ ok: false });
    expect(parseTailoringMeasurements({ unit: "in", values: { chest: 121 } })).toMatchObject({ ok: false });
    expect(parseTailoringMeasurements({ unit: "cm", values: { chest: 96.55 } })).toMatchObject({ ok: false });
    expect(parseTailoringMeasurements({ unit: "mm", values: { chest: 96 } })).toMatchObject({ ok: false, field: "unit" });
    expect(parseTailoringMeasurements({ unit: "cm", values: {} })).toMatchObject({ ok: false });
  });
  it("needs a stated purpose to open them; retention cutoff is days before today", () => {
    expect(parseAccessPurpose("  پرو دوم  ")).toBe("پرو دوم");
    expect(parseAccessPurpose("x")).toBeNull();
    expect(parseAccessPurpose(42)).toBeNull();
    expect(retentionCutoff(new Date("2026-11-25T00:00:00Z"), 30).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});

describe("GH #1567 6A — no AI access to measurements", () => {
  it("no AI tool, AI action or system AI read set carries the measurements key", () => {
    expect(Object.values(AI_TOOL_PERMISSION_MAP)).not.toContain(PERMISSIONS.tailoringMeasurements);
    expect(Object.values(AI_ACTION_PERMISSION_MAP)).not.toContain(PERMISSIONS.tailoringMeasurements);
    expect(SYSTEM_AI_READ_PERMISSIONS.has(PERMISSIONS.tailoringMeasurements)).toBe(false);
  });
  it("no MCP read tool or write verb names tailoring or measurements", () => {
    const names = [...MCP_READ_REGISTRY.map(entry => entry.name), ...MCP_WRITE_REGISTRY.map(entry => entry.actionType)];
    expect(names.filter(name => /tailor|measure/i.test(name))).toEqual([]);
  });
  it("no AI/MCP source module imports the tailoring service", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.") &&
          (dir.includes("/mcp") || /^ai[-.]/.test(entry)) && readFileSync(path, "utf8").includes("tailoring-service")) offenders.push(path);
      }
    };
    walk("src/lib");
    expect(offenders).toEqual([]);
  });
  it("RBAC: the manager runs jobs but does not see measurements; owner and admin do", () => {
    expect(effectivePermissions("manager", {}).has(PERMISSIONS.tailoringManage)).toBe(true);
    expect(effectivePermissions("manager", {}).has(PERMISSIONS.tailoringMeasurements)).toBe(false);
    expect(effectivePermissions("cashier", {}).has(PERMISSIONS.tailoringManage)).toBe(false);
    expect(effectivePermissions("owner", {}).has(PERMISSIONS.tailoringMeasurements)).toBe(true);
    expect(effectivePermissions("admin", {}).has(PERMISSIONS.tailoringMeasurements)).toBe(true);
    expect(effectivePermissions("cashier", { granted: [PERMISSIONS.tailoringMeasurements] }).has(PERMISSIONS.tailoringMeasurements)).toBe(true);
  });
});
