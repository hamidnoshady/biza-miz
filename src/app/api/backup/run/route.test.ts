import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  run: vi.fn(),
  preflight: vi.fn(),
  charge: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/backup-service", () => ({ runBackupNow: mocks.run }));
vi.mock("@/lib/billing-guard", () => ({
  preflightFeatureUse: mocks.preflight,
  chargeForFeature: mocks.charge,
}));

import { POST } from "./route";

const request = new NextRequest("http://app/api/backup/run", { method: "POST" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { businessId: "business-a", sub: "user-a" } });
  mocks.preflight.mockResolvedValue({ ok: true, willCharge: true, priceRial: 5_000, balanceRial: 50_000 });
  mocks.charge.mockResolvedValue({ ok: true, charged: true, balanceRial: 45_000 });
  mocks.run.mockResolvedValue({
    local: { status: "ok", runId: "run-1", artifact: "a.dump", sizeBytes: 1_024, mode: "logical" },
    cloud: { status: "disabled" },
  });
});

it("requires the backup capability and refuses before any charge", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await POST(request)).status).toBe(403);
  expect(mocks.preflight).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("returns the preflight 402/403 without running or charging", async () => {
  mocks.preflight.mockResolvedValue({
    ok: false,
    charged: false,
    error: "insufficient_credits",
    response: NextResponse.json({ error: "insufficient_credits" }, { status: 402 }),
  });
  const response = await POST(request);
  expect(response.status).toBe(402);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.charge).not.toHaveBeenCalled();
});

it("settles one use after a successful, non-empty artifact", async () => {
  const response = await POST(request);
  const body = await response.json();
  expect(mocks.charge).toHaveBeenCalledTimes(1);
  expect(body).toMatchObject({
    charged: true,
    balanceRial: 45_000,
    settlement: { action: "charge", reason: "verified_success" },
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("never charges a failed or busy attempt", async () => {
  mocks.run.mockResolvedValue({
    local: { status: "failed", error: "pg_dump failed: disk full at /var/backups/secret-path" },
    cloud: { status: "disabled" },
  });
  const failed = await POST(request);
  const failedBody = await failed.json();
  expect(mocks.charge).not.toHaveBeenCalled();
  expect(failedBody.settlement).toEqual({ action: "none", reason: "failed_attempt" });
  expect(failedBody.result.local.status).toBe("failed");
  // Internal error text is not echoed to the tenant.
  expect(JSON.stringify(failedBody)).not.toContain("secret-path");

  mocks.run.mockResolvedValue({ local: { status: "busy" }, cloud: { status: "disabled" } });
  const busy = await POST(request);
  expect(mocks.charge).not.toHaveBeenCalled();
  expect((await busy.json()).settlement).toEqual({ action: "none", reason: "cancelled_attempt" });
});

it("does not charge an empty artifact", async () => {
  mocks.run.mockResolvedValue({
    local: { status: "ok", runId: "run-1", artifact: "a.dump", sizeBytes: 0, mode: "logical" },
    cloud: { status: "disabled" },
  });
  await POST(request);
  expect(mocks.charge).not.toHaveBeenCalled();
});

it("still reports the artifact when settlement fails after the work", async () => {
  mocks.charge.mockRejectedValue(new Error("wallet row locked by another transaction"));
  const response = await POST(request);
  const body = await response.json();
  expect(body.result.local.status).toBe("ok");
  expect(body.charged).toBe(false);
});
