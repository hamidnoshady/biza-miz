/**
 * Issue #808 §3 — the F&B menu step follows sellable data, not categories.
 *
 * `syncMenuStepProgress` is what every wizard menu write calls (manual
 * category/item entry and the CSV/Excel import). A branch with at least one
 * active item completes the step; a branch with only categories clears any
 * marker left behind by the old "a category is a menu" rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settings from "./settings";
import * as db from "./db";
import { syncMenuStepProgress } from "./setup-state";

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return {
    ...actual,
    markStepDone: vi.fn(),
    reconcileWizardSteps: vi.fn(),
    getSetting: vi.fn(),
    getWizardProgress: vi.fn(),
  };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, query: vi.fn() };
});

function countReplies(n: number) {
  vi.mocked(db.query).mockResolvedValue({ rows: [{ n: String(n) }] } as never);
}

beforeEach(() => {
  vi.mocked(settings.markStepDone).mockReset();
  vi.mocked(settings.reconcileWizardSteps).mockReset();
  vi.mocked(db.query).mockReset();
});

describe("syncMenuStepProgress", () => {
  it("marks the step when the branch has an active item", async () => {
    countReplies(2);
    vi.mocked(settings.markStepDone).mockResolvedValue({
      steps: { menu: "2026-01-01T00:00:00.000Z" },
      completedAt: null,
    });

    const progress = await syncMenuStepProgress("biz-1", "loc-1");

    const [countSql, countParams] = vi.mocked(db.query).mock.calls[0];
    expect(countSql).toContain("is_active");
    expect(countParams).toEqual(["loc-1"]);
    expect(settings.markStepDone).toHaveBeenCalledWith("biz-1", "menu");
    expect(settings.reconcileWizardSteps).not.toHaveBeenCalled();
    expect(progress.steps.menu).toBeTruthy();
  });

  it("clears a stale marker when only categories exist (zero sellable items)", async () => {
    countReplies(0);
    vi.mocked(settings.reconcileWizardSteps).mockResolvedValue({ steps: {}, completedAt: null });

    await syncMenuStepProgress("biz-1", "loc-1");

    expect(settings.markStepDone).not.toHaveBeenCalled();
    expect(settings.reconcileWizardSteps).toHaveBeenCalledWith("biz-1", {
      done: [],
      undone: ["menu"],
    });
  });

  it("never invents a marker for a branch whose items are all inactive", async () => {
    // The count itself filters `is_active`, so an inactive-only menu reads as
    // zero and goes down the same repair path.
    countReplies(0);
    await syncMenuStepProgress("biz-1", "loc-1");
    const [sql] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("WHERE location_id = $1 AND is_active");
  });
});
