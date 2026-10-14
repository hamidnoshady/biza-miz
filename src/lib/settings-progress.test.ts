/**
 * Issue #808 §7 — setup progress writes cannot lose a concurrent marker.
 *
 * The old `markStepDone` read the whole `setup.progress` object, mutated it and
 * wrote it back, so two concurrent callers (two wizard steps, two devices, a
 * skip racing a step save) both read the same old object and the later write
 * erased the other's marker. `/api/setup/complete` had the same shape.
 *
 * These tests pin the replacement contract at the SQL boundary: one statement,
 * evaluated by the database against the row as it is at update time, with no
 * read-then-write in between. A real database run is the integration test's
 * job (integration/setup-complete.integration.test.ts); this pins that the
 * statements *are* the merge, so a future refactor back to read-modify-write
 * fails here first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "./db";
import { markSetupComplete, markStepDone, reconcileWizardSteps } from "./settings";

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, query: vi.fn(), getPool: vi.fn() };
});

const progress = (steps: Record<string, string>, completedAt: string | null = null) => ({
  steps,
  completedAt,
});

beforeEach(() => {
  vi.mocked(db.query).mockReset();
});

describe("markStepDone", () => {
  it("issues exactly one statement that merges the step in the database", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ value: progress({ menu: "2026-01-01T00:00:00.000Z" }) }],
    } as never);

    const result = await markStepDone("biz-1", "menu");

    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
    const [sql] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("INSERT INTO settings");
    expect(sql).toContain("ON CONFLICT (business_id, location_id, key) DO UPDATE");
    // The merge is the `||` on the *current* row, not on a value we read first.
    expect(sql).toContain("settings.value -> 'steps'");
    expect(sql).toContain("|| jsonb_build_object");
    // No read-modify-write in TypeScript: no SELECT of the whole row first.
    expect(sql.trimStart().toUpperCase().startsWith("SELECT")).toBe(false);
    expect(result.steps.menu).toBeTruthy();
  });

  it("preserves a completedAt stamped concurrently", async () => {
    // The statement never assigns completedAt in its UPDATE branch, so a
    // concurrent finish's stamp survives by construction.
    vi.mocked(db.query).mockResolvedValue({ rows: [{ value: progress({}, "2026-01-02T00:00:00.000Z") }] } as never);
    await markStepDone("biz-1", "opening");
    const [sql] = vi.mocked(db.query).mock.calls[0];
    const updateBranch = sql.slice(sql.indexOf("DO UPDATE"));
    expect(updateBranch).not.toContain("'completedAt'");
  });

  it("accepts a caller's client so the marker can share its transaction", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ value: progress({ opening: "2026-01-01T00:00:00.000Z" }) }] }),
    };
    await markStepDone("biz-1", "opening", client as never);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.query)).not.toHaveBeenCalled();
  });
});

describe("markSetupComplete", () => {
  it("stamps once with a single statement and reports it", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ value: progress({}, "2026-01-02T00:00:00.000Z") }],
    } as never);

    const result = await markSetupComplete("biz-1");

    expect(result.stamped).toBe(true);
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
    const [sql] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("WITH upsert AS");
    // Exactly-once comes from this guard: the second concurrent press matches
    // no row and therefore reports "not stamped".
    expect(sql).toContain("WHERE settings.value ->> 'completedAt' IS NULL");
  });

  it("reports not-stamped on a retry and does not overwrite the original time", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ value: null }] } as never) // the guarded update matched nothing
      .mockResolvedValueOnce({ rows: [{ value: progress({}, "2026-01-02T00:00:00.000Z") }] } as never);

    const result = await markSetupComplete("biz-1");

    expect(result.stamped).toBe(false);
    expect(result.progress.completedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("reconcileWizardSteps", () => {
  it("adds and removes markers in one statement, preserving completedAt and optional steps", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ value: progress({}, null) }] } as never);
    await reconcileWizardSteps("biz-1", { done: ["accounts"], undone: ["menu"] });

    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(db.query).mock.calls[0];
    expect(sql).toContain("jsonb_set");
    expect(sql).toContain("- $4::text[]"); // the removal operator
    expect(sql).toContain("COALESCE(settings.value -> 'completedAt', 'null'::jsonb)");
    expect(params?.[0]).toBe("biz-1");
    expect(params?.[1]).toBe("setup.progress");
    expect(params?.[3]).toEqual(["menu"]);
    expect(JSON.parse(String(params?.[2]))).toEqual({ accounts: expect.any(String) });
  });
});
