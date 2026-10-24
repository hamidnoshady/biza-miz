import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #1003 item 2 — «همگام‌سازی دوباره» on the staff login screen answers
 * before anybody has signed in, so it says no more than the roster does: two
 * counts and the missing members' names (`loginCredentialNotice`), with the
 * status code telling whether the planes converged. It used to return member
 * ids and roles and the raw text of the last sync error.
 */

type AnyFn = ReturnType<typeof vi.fn>;

function status(missing: number, overall: "healthy" | "degraded") {
  return {
    configured: true,
    overall,
    credentials: {
      status: overall,
      lastSuccessAt: "2026-10-20T10:00:00.000Z",
      lastError: missing ? "login_credentials_http_500 from https://cloud.internal.example:8443" : null,
    },
    pinGap: {
      expected: 3,
      usable: 3 - missing,
      missing,
      missingMembers: missing
        ? [{ id: "00000000-0000-4000-8000-000000000099", fullName: "کارمند آشپزخانه", role: "kitchen" }]
        : [],
    },
  };
}

const mocks = vi.hoisted(() => ({
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  readDeploymentProfile: vi.fn() as AnyFn,
  resolveLoginBusinessId: vi.fn() as AnyFn,
  runIamSync: vi.fn(async () => true) as AnyFn,
  readHybridIdentityStatus: vi.fn() as AnyFn,
  syncHybridLoginCredentials: vi.fn(async () => null) as AnyFn,
}));

vi.mock("@/lib/db", () => ({ withTenant: mocks.withTenant }));
vi.mock("@/lib/host", () => ({ requestHost: () => "alpha.example.com" }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.readDeploymentProfile }));
vi.mock("@/lib/employee-service", () => ({ resolveLoginBusinessId: mocks.resolveLoginBusinessId }));
vi.mock("@/lib/iam/sync", () => ({ runIamSync: mocks.runIamSync }));
vi.mock("@/lib/iam/login-credential-sync", () => ({
  readHybridIdentityStatus: mocks.readHybridIdentityStatus,
  syncHybridLoginCredentials: mocks.syncHybridLoginCredentials,
}));

import { POST } from "./route";

function retry() {
  return POST(new NextRequest("http://localhost/api/auth/pin-login/roster/sync", { method: "POST" }));
}

beforeEach(() => {
  mocks.resolveLoginBusinessId.mockResolvedValue({ businessId: "biz-1", error: null });
  mocks.readDeploymentProfile.mockResolvedValue({ profile: "hybrid" });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/auth/pin-login/roster/sync", () => {
  it("answers a converged site with the notice alone, without a round trip", async () => {
    mocks.readHybridIdentityStatus.mockResolvedValue(status(0, "healthy"));
    const response = await retry();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expected: 3, missing: 0, missingMembers: [] });
    expect(mocks.runIamSync).not.toHaveBeenCalled();
  });

  it("retries, and reports a gap that remains as 503 with counts and names only", async () => {
    mocks.readHybridIdentityStatus.mockResolvedValue(status(1, "degraded"));
    const response = await retry();
    expect(mocks.runIamSync).toHaveBeenCalledWith("biz-1");
    expect(mocks.syncHybridLoginCredentials).toHaveBeenCalledWith("biz-1");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ expected: 3, missing: 1, missingMembers: [{ fullName: "کارمند آشپزخانه" }] });
    const wire = JSON.stringify(body);
    for (const leaked of ["00000000-0000-4000-8000-000000000099", "kitchen", "cloud.internal.example", "lastError", "degraded"]) {
      expect(wire, leaked).not.toContain(leaked);
    }
  });

  it("answers 200 once the retry converged", async () => {
    mocks.readHybridIdentityStatus
      .mockResolvedValueOnce(status(1, "degraded"))
      .mockResolvedValueOnce(status(0, "healthy"));
    const response = await retry();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expected: 3, missing: 0, missingMembers: [] });
  });
});
