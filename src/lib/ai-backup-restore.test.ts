/**
 * Issue #903 §4 — the tenant AI verb must reach the same restore engine the
 * Owner's screen reaches.
 *
 * `backup.restore.apply` used to gate on `restoreAvailable()`, which is the
 * *physical, single-tenant* capability: on a central deployment it answered
 * `restore_not_available`, so a model was told the capability did not exist
 * while a logical tenant restore engine sat right behind it. Worse, the verb had
 * no way to respect the epic's "strong Owner authorization and
 * re-authentication" rule for that engine, because an executor has no session to
 * prove freshness with.
 *
 * The honest split, asserted here:
 *   - central   → the real preview (same engine), `owner_reauthentication_required`,
 *                 and nothing is applied;
 *   - site      → the physical replacement, unchanged, still behind
 *                 `restoreAvailable()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  physicalAllowed: vi.fn(),
  profile: vi.fn(),
  preview: vi.fn(),
  available: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("./deployment-role", () => ({ deploymentRole: mocks.role }));
vi.mock("./backup-policy", () => ({
  tenantPhysicalRestoreAllowed: mocks.physicalAllowed,
}));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("./tenant-backup-artifacts-service", () => ({ previewOwnedRestore: mocks.preview }));
vi.mock("./backup-service", () => ({
  restoreAvailable: mocks.available,
  restoreFromArtifact: mocks.restore,
}));

import { AUTOPILOT_EXECUTORS } from "./ai-autopilot-executors";

function run(payload: Record<string, unknown>) {
  return AUTOPILOT_EXECUTORS.backupRestoreApply({
    businessId: "business-a",
    authorizedByUserId: "user-a",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockReturnValue("central");
  mocks.physicalAllowed.mockReturnValue(false);
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.available.mockResolvedValue(true);
  mocks.preview.mockResolvedValue({
    preview: { artifactRef: "ref-1", confirmationPhrase: "کافه", blockers: [], canApply: false },
    jobId: "job-1",
  });
  mocks.restore.mockResolvedValue({ status: "ok" });
});

describe("backup.restore.apply on a central deployment", () => {
  it("refuses the apply and says who must do it, instead of claiming the capability is missing", async () => {
    const result = await run({ artifactId: "ref-1" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("owner_reauthentication_required");
    expect(result.result.applyInApp).toBe("/settings/backup");
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("returns the engine's own preview, so the model can explain the impact", async () => {
    const result = await run({ ref: "ref-1" });
    expect(mocks.preview).toHaveBeenCalledWith(
      "business-a",
      "ref-1",
      expect.objectContaining({
        // Never a fabricated security fact: an executor cannot prove MFA or a
        // fresh re-authentication, so the preview reports them as unsatisfied.
        actor: { canRestore: true, mfaSatisfied: false, reauthenticatedAt: null },
        actorUserId: "user-a",
        profile: "cloud",
      }),
    );
    expect(result.result.preview).toMatchObject({ artifactRef: "ref-1", confirmationPhrase: "کافه" });
  });

  it("does not pretend an unknown reference exists", async () => {
    mocks.preview.mockResolvedValue({ error: "artifact_not_found" });
    await expect(run({ artifactId: "foreign" })).resolves.toMatchObject({
      ok: false,
      errorCode: "artifact_not_found",
    });
  });

  it("still refuses a payload with no artifact", async () => {
    await expect(run({})).resolves.toMatchObject({ ok: false, errorCode: "missing_artifact" });
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});

describe("backup.restore.apply on a site install", () => {
  beforeEach(() => {
    mocks.role.mockReturnValue("site");
    mocks.physicalAllowed.mockReturnValue(true);
  });

  it("keeps the physical replacement, behind restoreAvailable()", async () => {
    const result = await run({ artifactId: "ref-1", apply: true });
    expect(mocks.available).toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledWith(
      "business-a",
      expect.objectContaining({ source: "artifact", artifactId: "ref-1", apply: true }),
    );
    expect(result.ok).toBe(true);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("never reaches the physical path when the single-business guard refuses", async () => {
    mocks.available.mockResolvedValue(false);
    await expect(run({ artifactId: "ref-1" })).resolves.toMatchObject({
      ok: false,
      errorCode: "restore_not_available",
    });
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
