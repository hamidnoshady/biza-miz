/**
 * Issue #1535 / ESH-218 — the optional import step's pure contract.
 *
 * Four promises are pinned here because every screen (wizard, Finish,
 * dashboard) derives its answer from them:
 *
 *  - a type owned by an app the owner did not select is unavailable and says
 *    so, while zero selected apps never hides shared workspace data;
 *  - a missing permission is distinct from an unselected app;
 *  - a staged / partial / failed job is never summarised as applied;
 *  - the legacy unset selection keeps every type available, as it was before
 *    the gallery existed.
 */
import { describe, expect, it } from "vitest";
import { resolveImportAccess } from "./import-access";
import {
  SETUP_IMPORT_MODULE_APP,
  isUnfinishedSetupImport,
  setupImportCandidates,
  setupImportSessionState,
  setupImportSummary,
  type SetupImportEntityInput,
  type SetupImportSessionState,
} from "./setup-imports";

function entity(
  overrides: Partial<SetupImportEntityInput> &
    Pick<SetupImportEntityInput, "key" | "module">,
): SetupImportEntityInput {
  return {
    label: overrides.key,
    description: "",
    importable: true,
    granted: true,
    ...overrides,
  };
}

const CUSTOMERS = entity({ key: "crm.customers", module: "crm", label: "مشتریان" });
const PRODUCTS = entity({ key: "pos.products", module: "pos", label: "محصولات" });
const WEBSITE = entity({ key: "website.products", module: "website" });
const TASKS = entity({ key: "workspace.tasks", module: "workspace" });
const INVOICES = entity({ key: "accounting.invoices", module: "accounting" });

describe("module → app ownership", () => {
  it("maps sales, stock and accounting to Accounting and leaves workspace shared", () => {
    expect(SETUP_IMPORT_MODULE_APP.accounting).toBe("accounting");
    expect(SETUP_IMPORT_MODULE_APP.inventory).toBe("accounting");
    expect(SETUP_IMPORT_MODULE_APP.pos).toBe("accounting");
    expect(SETUP_IMPORT_MODULE_APP.crm).toBe("crm");
    expect(SETUP_IMPORT_MODULE_APP.website).toBe("website");
    expect(SETUP_IMPORT_MODULE_APP.workspace).toBeNull();
  });
});

describe("setupImportCandidates", () => {
  it("offers only the selected apps' types, plus shared workspace data", () => {
    const candidates = setupImportCandidates(
      [CUSTOMERS, PRODUCTS, WEBSITE, TASKS],
      ["crm"],
    );

    expect(candidates.map((candidate) => candidate.key)).toEqual([
      "crm.customers",
      "pos.products",
      "website.products",
      "workspace.tasks",
    ]);
    expect(candidates[0].available).toBe(true);
    expect(candidates[1].reason).toBe("app_not_selected");
    expect(candidates[1].available).toBe(false);
    expect(candidates[1].reasonLabel).toContain("حسابداری");
    expect(candidates[2].reason).toBe("app_not_selected");
    expect(candidates[3].available).toBe(true);
    expect(candidates[3].appKey).toBeNull();
  });

  it("zero selected apps leaves the shared types and blocks every app-owned one", () => {
    const candidates = setupImportCandidates([CUSTOMERS, TASKS, INVOICES], []);
    expect(candidates.find((c) => c.key === "workspace.tasks")?.available).toBe(true);
    expect(candidates.find((c) => c.key === "crm.customers")?.reason).toBe(
      "app_not_selected",
    );
    expect(candidates.find((c) => c.key === "accounting.invoices")?.reason).toBe(
      "app_not_selected",
    );
  });

  it("keeps the legacy unset selection open, exactly as before the gallery", () => {
    for (const candidate of setupImportCandidates(
      [CUSTOMERS, PRODUCTS, WEBSITE, INVOICES],
      null,
    )) {
      expect(candidate.available, candidate.key).toBe(true);
    }
  });

  it("distinguishes a missing permission from an unselected app", () => {
    const candidates = setupImportCandidates(
      [{ ...CUSTOMERS, granted: false }, PRODUCTS],
      [],
    );
    expect(candidates[0].reason).toBe("permission");
    expect(candidates[0].reasonLabel).toContain("مجوز");
    // Permission is reported before the app-selection reason: selecting the
    // app would not unlock a type the member may never import.
    expect(candidates[1].reason).toBe("app_not_selected");
  });

  it("marks a type with no supported write path as unavailable, even when its app is selected", () => {
    const candidates = setupImportCandidates(
      [{ ...PRODUCTS, importable: false }],
      ["accounting"],
    );
    expect(candidates[0].available).toBe(false);
    expect(candidates[0].reason).toBe("not_importable");
    expect(candidates[0].reasonLabel).toContain("پشتیبانی");
  });

  it("hides a data type the business type has no module for (issue #1239)", () => {
    // Menu categories/items/modifiers are F&B's. A jewellery shop that
    // selected Accounting must not be offered them, even though pos.* belongs
    // to that app and the member may hold menu.edit.
    const candidates = setupImportCandidates(
      [{ ...PRODUCTS, industryEligible: false }],
      ["accounting"],
    );
    expect(candidates[0].available).toBe(false);
    expect(candidates[0].reason).toBe("industry_module");
    expect(candidates[0].reasonLabel).toContain("نوع کسب‌وکار");
  });

  it("reports a missing module before a missing permission", () => {
    // Selecting an app or granting a permission still would not make a menu
    // import meaningful for this trade, so the trade reason comes first.
    const candidates = setupImportCandidates(
      [{ ...PRODUCTS, industryEligible: false, granted: false }],
      ["accounting"],
    );
    expect(candidates[0].reason).toBe("industry_module");
  });

  it("carries the effective service decision (#1580) and separates staging from applying", () => {
    const access = (activationState: string | null) =>
      resolveImportAccess({
        appKey: "accounting",
        selection: ["accounting"],
        activationState,
        permitted: true,
        importable: true,
        at: "2026-11-27T00:00:00.000Z",
      });

    const [active, pending, disabled] = setupImportCandidates(
      [
        { ...PRODUCTS, key: "a", access: access("active") },
        { ...PRODUCTS, key: "b", access: access(null) },
        { ...PRODUCTS, key: "c", access: access("disabled_retained") },
      ],
      ["accounting"],
    );

    expect(active).toMatchObject({ available: true, stagingAllowed: true, reason: null });
    expect(pending).toMatchObject({
      available: false,
      stagingAllowed: true,
      reason: "awaiting_activation",
    });
    expect(pending.reasonLabel).toContain("منتظر فعال‌سازی");
    expect(disabled).toMatchObject({
      available: false,
      stagingAllowed: false,
      reason: "service_disabled",
    });
  });
});

describe("truthful job states", () => {
  it("never reports a staged, queued or partial job as applied", () => {
    expect(setupImportSessionState({ status: "pending", failedRows: 0 })).toBe("staged");
    expect(setupImportSessionState({ status: "ready", failedRows: 0 })).toBe("staged");
    expect(setupImportSessionState({ status: "queued", failedRows: 0 })).toBe("applying");
    expect(setupImportSessionState({ status: "running", failedRows: 0 })).toBe("applying");
    expect(setupImportSessionState({ status: "completed", failedRows: 3 })).toBe("partial");
    expect(setupImportSessionState({ status: "completed", failedRows: 0 })).toBe("applied");
    expect(setupImportSessionState({ status: "failed", failedRows: 0 })).toBe("failed");
    expect(setupImportSessionState({ status: "cancelled", failedRows: 0 })).toBe("cancelled");
  });

  it("counts every not-applied state as unfinished, and nothing else", () => {
    const states: SetupImportSessionState[] = [
      "applied",
      "applied",
      "staged",
      "applying",
      "partial",
      "failed",
      "cancelled",
    ];
    const summary = setupImportSummary(states);
    expect(summary).toEqual({
      total: 7,
      applied: 2,
      partial: 1,
      staged: 1,
      applying: 1,
      failed: 1,
      cancelled: 1,
      unfinished: 4,
    });
    expect(isUnfinishedSetupImport("applied")).toBe(false);
    expect(isUnfinishedSetupImport("cancelled")).toBe(false);
    expect(isUnfinishedSetupImport("partial")).toBe(true);
  });

  it("an empty history is a valid, finished summary", () => {
    expect(setupImportSummary([])).toEqual({
      total: 0,
      applied: 0,
      partial: 0,
      staged: 0,
      applying: 0,
      failed: 0,
      cancelled: 0,
      unfinished: 0,
    });
  });
});
