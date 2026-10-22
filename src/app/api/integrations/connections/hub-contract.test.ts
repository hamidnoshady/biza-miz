import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./[id]/route";
import { GET as overview } from "../overview/route";
import { GET as history, POST as migrate } from "./[id]/migration/route";
import { getAccessibleConnection, listAccessibleConnections } from "@/lib/integrations/connection-access";
import { updateConnection } from "@/lib/integrations/connections-service";
import { listImportRuns } from "@/lib/integrations/holoo/migration-run-service";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(async () => ({ error: null, session: { sub: "manager", businessId: "tenant-a" } })),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: "a1" })) }));
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn(), listAccessibleConnections: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({ updateConnection: vi.fn(async () => ({ ok: true, connection: {} })), deleteConnection: vi.fn() }));
vi.mock("@/lib/integrations/holoo/migration-run-service", () => ({ listImportRuns: vi.fn(async () => []) }));
vi.mock("@/lib/integrations/holoo/import-service", () => ({ previewBaseImport: vi.fn() }));
vi.mock("@/lib/integrations/holoo/transaction-import-service", () => ({ previewTransactions: vi.fn() }));
vi.mock("@/lib/integrations/holoo/migration-discrepancy-service", () => ({ buildMigrationDiscrepancyReport: vi.fn() }));
const context = { params: Promise.resolve({ id: "connection" }) };
const request = (body: unknown, method = "PATCH") => new NextRequest("https://biza.example/api/integrations/connections/connection", { method, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccessibleConnection).mockResolvedValue({ provider: "woocommerce", location_id: "a1" } as never);
});
it("isolates the Woo overview from mixed Woo/Holoo fixtures", async () => {
  vi.mocked(listAccessibleConnections).mockResolvedValue([{ id: "woo", provider: "woocommerce" }, { id: "holoo", provider: "holoo" }] as never);
  const response = await overview();
  expect((await response.json()).connections.map((c: { id: string }) => c.id)).toEqual(["woo"]);
});
it.each(["a2", "b1", null])("rejects branch reassignment to %s before any mutation", async (locationId) => {
  expect((await PATCH(request({ locationId }), context)).status).toBe(403);
  expect(updateConnection).not.toHaveBeenCalled();
});
it("permits the active authorized branch and passes tenant scoping to the service", async () => {
  expect((await PATCH(request({ locationId: "a1" }), context)).status).toBe(200);
  expect(updateConnection).toHaveBeenCalledWith("tenant-a", "connection", expect.objectContaining({ locationId: "a1" }));
});
it("rejects an inaccessible source connection before moving it", async () => {
  vi.mocked(getAccessibleConnection).mockResolvedValue(null);
  expect((await PATCH(request({ locationId: "a1" }), context)).status).toBe(404);
  expect(updateConnection).not.toHaveBeenCalled();
});
it("does not attach Woo-specific controls/settings to a Holoo connection", async () => {
  vi.mocked(getAccessibleConnection).mockResolvedValue({ provider: "holoo" } as never);
  expect((await PATCH(request({ consumerKey: "ck_wrong_provider" }), context)).status).toBe(400);
  expect(updateConnection).not.toHaveBeenCalled();
});
it("rejects non-Holoo migration history instead of returning another provider's runs", async () => {
  expect((await history(new Request("https://biza.example"), context)).status).toBe(404);
  expect(listImportRuns).not.toHaveBeenCalled();
});
it.each(["apply", "rollback"])("retires the weaker legacy %s bypass in favor of #845", async (action) => {
  vi.mocked(getAccessibleConnection).mockResolvedValue({ provider: "holoo" } as never);
  const response = await migrate(request({ action, manifest: {}, runId: "run" }, "POST"), context);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "use_data_transfer", path: "/settings/transfer" });
});
