import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  readOverride: vi.fn(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
}));
vi.mock("./tenant-backup-storage", () => ({
  readBusinessPolicyOverride: mocks.readOverride,
}));

import {
  checkRestoreApproval,
  consumeRestoreApproval,
  grantRestoreApproval,
  MAX_APPROVAL_TTL_MINUTES,
  restoreApprovalRequired,
  revokeRestoreApproval,
  validatePolicyOverrideBody,
} from "./tenant-backup-approvals";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function approvalRow(patch: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    artifact_ref: "ref-1",
    approved_by: "admin-1",
    approved_at: new Date("2026-10-01T00:00:00Z"),
    expires_at: new Date("2026-10-02T00:00:00Z"),
    consumed_at: null,
    consumed_journal_id: null,
    note: "",
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.readOverride.mockResolvedValue(null);
});

describe("restore approval requirement", () => {
  it("is off when the business has no override row", async () => {
    await expect(restoreApprovalRequired(BUSINESS)).resolves.toBe(false);
    await expect(checkRestoreApproval(BUSINESS, "ref-1")).resolves.toEqual({ ok: true, approval: null });
    // No approval lookup happens at all when the control is off.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("is off when the override exists but left the switch alone", async () => {
    mocks.readOverride.mockResolvedValue({ require_restore_approval: false });
    await expect(restoreApprovalRequired(BUSINESS)).resolves.toBe(false);
  });

  it("refuses when the business requires an approval and none is valid", async () => {
    mocks.readOverride.mockResolvedValue({ require_restore_approval: true });
    await expect(checkRestoreApproval(BUSINESS, "ref-1")).resolves.toEqual({
      ok: false,
      error: "restore_approval_required",
    });
  });

  it("passes the approval that authorises exactly this artifact", async () => {
    mocks.readOverride.mockResolvedValue({ require_restore_approval: true });
    mocks.query.mockResolvedValue({ rows: [approvalRow()] });
    const gate = await checkRestoreApproval(BUSINESS, "ref-1");
    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.approval?.id).toBe("approval-1");
    // The lookup is bound to the business *and* the reference.
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("business_id = $1 AND artifact_ref = $2"),
      expect.arrayContaining([BUSINESS, "ref-1"]),
    );
  });

  it("ignores an approval that was already consumed or has expired", async () => {
    mocks.readOverride.mockResolvedValue({ require_restore_approval: true });
    // The SQL filters both, so an empty result is the whole story.
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(checkRestoreApproval(BUSINESS, "ref-1")).resolves.toMatchObject({
      ok: false,
      error: "restore_approval_required",
    });
    const [, params] = mocks.query.mock.calls[0];
    expect(params).toHaveLength(3); // business, ref, now
  });
});

describe("granting an approval", () => {
  it("clamps the window instead of granting open-ended consent", async () => {
    mocks.query.mockResolvedValue({ rows: [approvalRow()] });
    const now = new Date("2026-10-01T00:00:00Z");
    await grantRestoreApproval({
      businessId: BUSINESS,
      artifactRef: "ref-1",
      approvedBy: "admin-1",
      ttlMinutes: MAX_APPROVAL_TTL_MINUTES * 10,
      now,
    });
    const [, params] = mocks.query.mock.calls[0];
    const expiresAt = params[4] as Date;
    expect(expiresAt.getTime() - now.getTime()).toBe(MAX_APPROVAL_TTL_MINUTES * 60_000);
  });

  it("treats a nonsense window as one minute, never as forever", async () => {
    mocks.query.mockResolvedValue({ rows: [approvalRow()] });
    const now = new Date("2026-10-01T00:00:00Z");
    await grantRestoreApproval({
      businessId: BUSINESS,
      artifactRef: "ref-1",
      approvedBy: "admin-1",
      ttlMinutes: Number.NaN,
      now,
    });
    const [, params] = mocks.query.mock.calls[0];
    const expiresAt = params[4] as Date;
    expect(expiresAt.getTime() - now.getTime()).toBeGreaterThan(0);
    expect(expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(MAX_APPROVAL_TTL_MINUTES * 60_000);
  });
});

describe("consuming and revoking", () => {
  it("consumes once, with a conditional update", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1 });
    await expect(consumeRestoreApproval("approval-1", "journal-1")).resolves.toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1 AND consumed_at IS NULL"),
      ["approval-1", expect.any(Date), "journal-1"],
    );
  });

  it("reports the loser of a race rather than claiming the approval", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0 });
    await expect(consumeRestoreApproval("approval-1", null)).resolves.toBe(false);
  });

  it("cannot revoke consent that was already used", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0 });
    await expect(revokeRestoreApproval(BUSINESS, "approval-1")).resolves.toBe(false);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("AND consumed_at IS NULL"),
      [BUSINESS, "approval-1"],
    );
  });
});

describe("validatePolicyOverrideBody", () => {
  it("accepts the fields the console may set, including 'inherit' as null", () => {
    expect(
      validatePolicyOverrideBody({ intervalHours: 6, retentionDays: null, keepCount: 12 }),
    ).toEqual({ ok: true, value: { intervalHours: 6, retentionDays: null, keepCount: 12 } });
  });

  it("refuses a cadence the scheduler cannot express", () => {
    expect(validatePolicyOverrideBody({ intervalHours: 5 })).toEqual({
      ok: false,
      error: "invalid_intervalHours",
    });
  });

  it("refuses out-of-range numbers instead of letting the CHECK constraint 500", () => {
    expect(validatePolicyOverrideBody({ retentionDays: 0 })).toEqual({
      ok: false,
      error: "invalid_retentionDays",
    });
    expect(validatePolicyOverrideBody({ keepCount: 5000 })).toEqual({
      ok: false,
      error: "invalid_keepCount",
    });
  });

  it("refuses a field the override does not own", () => {
    // A console must not be able to smuggle, say, a destination through here.
    expect(validatePolicyOverrideBody({ bucket: "x" })).toEqual({ ok: false, error: "unknown_field" });
  });

  it("refuses a non-boolean approval switch and an over-long note", () => {
    expect(validatePolicyOverrideBody({ requireRestoreApproval: "yes" })).toEqual({
      ok: false,
      error: "invalid_requireRestoreApproval",
    });
    expect(validatePolicyOverrideBody({ note: "x".repeat(501) })).toEqual({
      ok: false,
      error: "invalid_note",
    });
  });
});
