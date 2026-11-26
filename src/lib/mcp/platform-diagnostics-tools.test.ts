/**
 * Issue #1432 — read-only operational diagnostics on the Superadmin MCP.
 *
 * The point of these tests is the boundary, not the happy path alone:
 *
 *  - the two diagnostics are visible to any read-capable admin role, while the
 *    device inventory keeps its owner-only `business.provision` gate;
 *  - none of them is a step-up mutation, and no write lane (run/verify/restore/
 *    activate/retention) is reachable through them;
 *  - a business outside the credential's bridge list is refused before any
 *    service is called, so one tenant's diagnostics can never be read with
 *    another tenant's name in the answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBusiness: vi.fn(async (id: string) => ({
    id,
    name: `Business ${id}`,
    slug: id,
    industry: "cafe",
    ownershipKind: "tenant" as const,
  })),
  listSiteDevices: vi.fn(async () => [{ id: "site-1", name: "Site" }]),
  listPairingCodes: vi.fn(async () => [{ id: "code-1", state: "valid" }]),
  listPairingLocations: vi.fn(async () => [{ id: "loc-1", name: "Main" }]),
  listLocalInstallations: vi.fn(async () => [
    {
      id: "install-1",
      publicId: "pub-1",
      installationIdMasked: "…abcd",
      status: "active" as const,
      onlineNow: true,
      appVersion: "1.0.256",
      schemaVersion: "0319",
      lastSeenAt: "2026-11-26T09:00:00.000Z",
      credentialRotationPending: false,
    },
  ]),
  diagnoseBusinessBackup: vi.fn(async () => ({
    businessId: "biz-a",
    artifacts: { ready: 2, failed: 0, total: 2 },
    drill: null,
    dr: { rpoHours: 24, newestVerifiedAt: "2026-11-26T03:00:00.000Z", ageHours: 7, breached: false },
    actions: [],
  })),
  listBusinessServices: vi.fn(async () => [
    { identity: { kind: "workspace", key: "workspace" }, state: "active", retentionDeadline: null, purgeState: "none" },
  ]),
  listServiceRuntimeSummary: vi.fn(async () => [
    { activationId: "act-1", state: "active", settledSeconds: 3600, chargedRial: 1000, upcomingHourRial: 1000 },
  ]),
  listBusinessRetentionOverrides: vi.fn(async () => [
    { kind: "workspace", key: "workspace", autoPurgeEnabled: false, retentionDays: null },
  ]),
  audit: vi.fn(async () => {}),
}));

vi.mock("../db", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withoutTenantScope: (_reason: string, work: () => unknown) => work(),
}));

vi.mock("../platform-auth", () => ({
  platformAudit: mocks.audit,
  revokeAllPlatformAdminSessions: vi.fn(async () => {}),
}));

vi.mock("../platform-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform-service")>();
  return { ...actual, getBusiness: mocks.getBusiness };
});

vi.mock("../site-device-service", () => ({ listSiteDevices: mocks.listSiteDevices }));
vi.mock("../pairing-service", () => ({
  listPairingCodes: mocks.listPairingCodes,
  listPairingLocations: mocks.listPairingLocations,
}));
vi.mock("../local-activation-cloud-service", () => ({
  listLocalInstallations: mocks.listLocalInstallations,
}));
vi.mock("../platform-tenant-backup-ops", () => ({
  diagnoseBusinessBackup: mocks.diagnoseBusinessBackup,
}));
vi.mock("../service-activation/activation-service", () => ({
  listBusinessServices: mocks.listBusinessServices,
  listServiceRuntimeSummary: mocks.listServiceRuntimeSummary,
}));
vi.mock("../service-activation/retention-service", () => ({
  listBusinessRetentionOverrides: mocks.listBusinessRetentionOverrides,
}));

import {
  PLATFORM_MCP_TOOLS,
  callPlatformMcpTool,
  platformMcpToolCatalogue,
  type PlatformMcpConnection,
} from "./platform-mcp";

function connection(overrides: Partial<PlatformMcpConnection> = {}): PlatformMcpConnection {
  return {
    id: "connection-1",
    adminId: "admin-1",
    adminName: "Desk",
    adminRole: "support",
    name: "test-connector",
    origin: "token",
    capabilities: ["business.reports.read", "tenant_backup.read", "business.provision"],
    businessIds: null,
    status: "active",
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const names = (conn: PlatformMcpConnection) => platformMcpToolCatalogue(conn).map((tool) => tool.name);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("issue #1432 — read-only diagnostics in the Superadmin MCP catalogue", () => {
  it("exposes both diagnostics to a read-capable role and none of the write lanes", () => {
    const catalogue = names(connection({ adminRole: "support" }));
    expect(catalogue).toContain("get_business_backup_diagnostics");
    expect(catalogue).toContain("get_business_service_status");
    // The device inventory keeps its owner-only provision gate.
    expect(catalogue).not.toContain("list_provision_devices");

    // No diagnostic verb can run/verify/restore a backup or change services.
    for (const forbidden of ["run_backup_now", "verify_backup_cloud_object", "set_business_status"]) {
      expect(catalogue).not.toContain(forbidden);
    }
  });

  it("marks the diagnostics as read-only tools, never step-up mutations", () => {
    const byName = new Map(PLATFORM_MCP_TOOLS.map((tool) => [tool.name, tool]));
    for (const name of ["get_business_backup_diagnostics", "get_business_service_status", "list_provision_devices"]) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.stepUp, name).toBeFalsy();
      expect(tool?.bridged, name).toBe(true);
    }
  });

  it("keeps a role-side downgrade effective: the capability on the token is not enough", async () => {
    // The credential lists business.provision, but a support admin cannot hold it.
    const result = await callPlatformMcpTool(connection(), "list_provision_devices", {
      businessId: "biz-a",
    });
    expect(result.data).toBeNull();
    expect(result.text).toContain("denied");
    expect(mocks.listLocalInstallations).not.toHaveBeenCalled();
  });
});

describe("issue #1432 — per-business diagnostics stay inside the bridge scope", () => {
  it("refuses a business outside the credential's bridge list before calling any service", async () => {
    const result = await callPlatformMcpTool(
      connection({ businessIds: ["biz-a"] }),
      "get_business_backup_diagnostics",
      { businessId: "biz-b" },
    );
    expect(result.data).toBeNull();
    expect(result.text).toContain("denied");
    expect(mocks.diagnoseBusinessBackup).not.toHaveBeenCalled();
    expect(mocks.listSiteDevices).not.toHaveBeenCalled();
  });

  it("returns the managed-backup diagnosis unchanged for the selected business", async () => {
    const result = await callPlatformMcpTool(connection(), "get_business_backup_diagnostics", {
      businessId: "biz-a",
    });
    expect(mocks.diagnoseBusinessBackup).toHaveBeenCalledWith("biz-a");
    expect(result.data).toEqual({
      perBusiness: {
        "biz-a": {
          ok: true,
          diagnostics: {
            businessId: "biz-a",
            artifacts: { ready: 2, failed: 0, total: 2 },
            drill: null,
            dr: { rpoHours: 24, newestVerifiedAt: "2026-11-26T03:00:00.000Z", ageHours: 7, breached: false },
            actions: [],
          },
        },
      },
    });
    // No credential, URL or artifact-bytes field is invented by the tool.
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toMatch(/secret|password|accessKey|signedUrl|download/i);
  });

  it("returns activation, runtime and retention state for the selected business", async () => {
    const result = await callPlatformMcpTool(connection(), "get_business_service_status", {
      businessId: "biz-a",
    });
    expect(mocks.listBusinessServices).toHaveBeenCalledWith("biz-a");
    expect(mocks.listServiceRuntimeSummary).toHaveBeenCalledWith("biz-a");
    expect(mocks.listBusinessRetentionOverrides).toHaveBeenCalledWith("biz-a");
    const perBusiness = (result.data as { perBusiness: Record<string, { ok: boolean }> }).perBusiness;
    expect(perBusiness["biz-a"].ok).toBe(true);
  });

  it("lists the four device kinds apart, including local installations", async () => {
    const result = await callPlatformMcpTool(
      connection({ adminRole: "owner" }),
      "list_provision_devices",
      { businessId: "biz-a" },
    );
    expect(mocks.listLocalInstallations).toHaveBeenCalledWith("biz-a");
    const entry = (result.data as { perBusiness: Record<string, Record<string, unknown>> }).perBusiness["biz-a"];
    expect(Object.keys(entry).sort()).toEqual(
      ["codes", "installations", "localInstallations", "locations", "ok"].sort(),
    );
  });
});
