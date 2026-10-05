/**
 * Issue #808 §1/§2 — one canonical definition of "the wizard is finished".
 *
 * `isSetupComplete` drives the routing that decides whether an owner sees the
 * wizard or the app. It used to also answer true when every required step was
 * satisfied, which ejected owners from `/setup` before Hardware/Backup/Opening
 * and let a business behave complete with `completedAt` still null (so the
 * completion audit event never existed). These tests pin the new rule: the
 * marker, and only the marker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settings from "./settings";
import * as db from "./db";
import { isSetupComplete } from "./setup-state";

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return {
    ...actual,
    getWizardProgress: vi.fn(),
    getSetting: vi.fn(),
  };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    query: vi.fn().mockResolvedValue({ rows: [] }),
    withTenant: (_businessId: string, run: () => Promise<unknown>) => run(),
  };
});

beforeEach(() => {
  vi.mocked(settings.getWizardProgress).mockReset();
  vi.mocked(settings.getSetting).mockReset();
  vi.mocked(db.query).mockReset().mockResolvedValue({ rows: [] } as never);
});

describe("isSetupComplete", () => {
  it("is true once completedAt is stamped", async () => {
    vi.mocked(settings.getWizardProgress).mockResolvedValue({
      steps: { business: "2026-01-01T00:00:00.000Z" }, // deliberately incomplete
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(await isSetupComplete("biz-1")).toBe(true);
  });

  it("is false when every required step is marked but the wizard was never finished", async () => {
    vi.mocked(settings.getWizardProgress).mockResolvedValue({
      steps: {
        business: "2026-01-01T00:00:00.000Z",
        accounts: "2026-01-01T00:00:00.000Z",
        costing: "2026-01-01T00:00:00.000Z",
        tax: "2026-01-01T00:00:00.000Z",
        menu: "2026-01-01T00:00:00.000Z",
      },
      completedAt: null,
    });
    expect(await isSetupComplete("biz-1")).toBe(false);
  });

  it("reads the marker alone — no domain counts are consulted", async () => {
    vi.mocked(settings.getWizardProgress).mockResolvedValue({
      steps: {},
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(await isSetupComplete("biz-1")).toBe(true);
    // The old implementation called computeSetupState(), whose counts would
    // appear here as `SELECT count(*)` reads.
    expect(vi.mocked(db.query)).not.toHaveBeenCalled();
  });

  it("fails closed when there is no progress row at all", async () => {
    vi.mocked(settings.getWizardProgress).mockResolvedValue({ steps: {}, completedAt: null });
    expect(await isSetupComplete("biz-1")).toBe(false);
  });
});
