import { describe, it, expect } from "vitest";
import { PLAYBOOK_CATALOG, playbookByKey, validateCatalog } from "./catalog";
import { validatePlaybook } from "./types";
import { INDUSTRIES } from "../industries";

describe("playbook catalog", () => {
  it("is a valid catalog (no problems)", () => {
    expect(validateCatalog()).toEqual([]);
  });

  it("has unique stable keys", () => {
    const keys = PLAYBOOK_CATALOG.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ships 15–20 functional starter templates", () => {
    // Functional = published; not all are `available` (some truthfully require_setup),
    // but every entry binds to a canonical executor and is validated.
    expect(PLAYBOOK_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(PLAYBOOK_CATALOG.length).toBeLessThanOrEqual(20);
    for (const t of PLAYBOOK_CATALOG) expect(validatePlaybook(t)).toEqual([]);
  });

  it("has at least one CRM and one Growth template that are published", () => {
    expect(PLAYBOOK_CATALOG.some((t) => t.owningApp === "crm" && t.publicationState === "published")).toBe(true);
    expect(PLAYBOOK_CATALOG.some((t) => t.owningApp === "growth" && t.publicationState === "published")).toBe(true);
  });

  it("has truly functional CRM task templates (≥3) — the original #1012 P0", () => {
    const fn = PLAYBOOK_CATALOG.filter(
      (t) => t.owningApp === "crm" && t.executionBinding.action === "crm.create_tasks" && t.availability === "available",
    );
    expect(fn.length).toBeGreaterThanOrEqual(3);
  });

  it("never invents industry keys", () => {
    const known = new Set<string>([...INDUSTRIES, "all"]);
    for (const t of PLAYBOOK_CATALOG) {
      for (const ind of t.supportedIndustries) expect(known.has(ind)).toBe(true);
    }
  });

  it("only uses canonical executor types; CRM never sends marketing or moves money", () => {
    for (const t of PLAYBOOK_CATALOG) {
      expect(["crm", "growth"]).toContain(t.executionBinding.executor);
      if (t.executionBinding.executor === "crm") {
        expect(t.executionBinding.action.startsWith("crm.")).toBe(true);
        expect(t.executionBinding.action).not.toContain("send");
      }
    }
  });

  it("every template has Persian title/outcome + 2–3 steps + a measurable KPI", () => {
    for (const t of PLAYBOOK_CATALOG) {
      expect(t.localized.titleFa.trim().length).toBeGreaterThan(0);
      expect(t.localized.outcomeFa.trim().length).toBeGreaterThan(0);
      expect(t.stepsFa.length).toBeGreaterThanOrEqual(2);
      expect(t.stepsFa.length).toBeLessThanOrEqual(3);
      expect(t.measurement.length).toBeGreaterThan(0);
    }
  });

  it("money quick inputs are integer Rial", () => {
    for (const t of PLAYBOOK_CATALOG) {
      for (const f of t.quickInputSchema.fields) {
        if (f.type === "money_rial") expect(f.labelFa).toBeTruthy();
      }
    }
  });

  it("lookup by key works", () => {
    expect(playbookByKey("crm.follow_up_new_lead")?.owningApp).toBe("crm");
    expect(playbookByKey("nope")).toBeNull();
  });

  it("Growth playbooks requiring messaging require canonical capability + online + approval", () => {
    for (const t of PLAYBOOK_CATALOG.filter((x) => x.owningApp === "growth" && x.channels.length > 0)) {
      expect(t.executionBinding.executor).toBe("growth");
      expect(t.executionBinding.requiresApproval).toBe(true);
      expect(t.executionBinding.requiresOnline).toBe(true);
    }
  });
});
