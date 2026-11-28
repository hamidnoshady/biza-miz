import { describe, it, expect } from "vitest";
import { validateQuickInputs } from "./quick-input";
import { playbookByKey } from "./catalog";

const lead = playbookByKey("crm.follow_up_new_lead")!;
const winback = playbookByKey("growth.winback_inactive")!;

describe("validateQuickInputs", () => {
  it("applies safe authorized defaults", () => {
    const r = validateQuickInputs(lead, {});
    expect(r.ok).toBe(true);
    expect(r.values.slaHours).toBe(24);
  });
  it("rejects unknown keys (closed schema; no JSON/rule-graph injection)", () => {
    const r = validateQuickInputs(lead, { slaHours: 1, evil: "drop table" });
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.field === "evil" && p.message === "unknown_field")).toBe(true);
  });
  it("rejects invalid enum, boolean, number", () => {
    expect(validateQuickInputs(winback, { channel: "fax", messageBody: "x" }).ok).toBe(false);
    expect(validateQuickInputs(winback, { channel: "sms", messageBody: "x", inactiveDays: -1 }).ok).toBe(false);
    expect(validateQuickInputs(winback, { channel: "sms", messageBody: "x", inactiveDays: 1.5 }).ok).toBe(false);
  });
  it("money_rial must be integer Rial ≥ 0", () => {
    // synthetic template
    const t = { ...winback, quickInputSchema: { fields: [{ key: "incentiveRial", type: "money_rial" as const, labelFa: "x", required: false, min: 0 }] } };
    expect(validateQuickInputs(t, { incentiveRial: 1000 }).ok).toBe(true);
    expect(validateQuickInputs(t, { incentiveRial: 10.5 }).ok).toBe(false);
    expect(validateQuickInputs(t, { incentiveRial: -5 }).ok).toBe(false);
    expect(validateQuickInputs(t, { incentiveRial: "abc" }).ok).toBe(false);
  });
  it("enforces min/max", () => {
    expect(validateQuickInputs(lead, { slaHours: 99999 }).ok).toBe(false);
  });
  it("rejects non-object root", () => {
    expect(validateQuickInputs(lead, "nope").ok).toBe(false);
    expect(validateQuickInputs(lead, []).ok).toBe(false);
  });
  it("required field missing fails", () => {
    expect(validateQuickInputs(winback, {}).ok).toBe(false); // messageBody required
  });
});
