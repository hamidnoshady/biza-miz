import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
  wooClientFor: vi.fn(),
}));
vi.mock("@/lib/integrations/plugin-service", () => ({ enqueuePluginExport: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ syncProducts: vi.fn() }));
vi.mock("@/lib/integrations/wp-content-service", () => ({
  enqueueContentExport: vi.fn(),
  syncWpContentRest: vi.fn(),
}));

import * as connectionsService from "@/lib/integrations/connections-service";
import * as pluginService from "@/lib/integrations/plugin-service";
import * as syncService from "@/lib/integrations/sync-service";
import * as wpContent from "@/lib/integrations/wp-content-service";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";

function wooConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    business_id: SESSION.businessId,
    provider: "woocommerce",
    status: "active",
    link_mode: "rest_api",
    sync_products: true,
    ...overrides,
  };
}

function post() {
  return POST(
    new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/sync/products`, {
      method: "POST",
    }) as never,
    { params: Promise.resolve({ id: CONNECTION_ID }) } as never,
  );
}

const FULL_OUTCOME = {
  created: 2,
  updated: 3,
  skipped: 0,
  variations: 1,
  containers: 1,
  total: 5,
  failed: 0,
  failureIds: [],
  variationFetchFailures: 0,
  variationFailureIds: [],
  taxonomyError: null,
  partial: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(wooConnection() as never);
  vi.mocked(syncService.syncProducts).mockResolvedValue(FULL_OUTCOME as never);
  vi.mocked(wpContent.syncWpContentRest).mockResolvedValue(undefined as never);
});

describe("POST sync/products — authorization and guards", () => {
  it("gates on woocommerce.sync — the queue's own capability", async () => {
    await post();
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync);
  });

  it("rejects a Holoo connection with 404", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue(wooConnection({ provider: "holoo" }) as never);
    const res = await post();
    expect(res.status).toBe(404);
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });

  it("refuses a paused connection and one with product sync disabled", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue(wooConnection({ status: "paused" }) as never);
    const paused = await post();
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ error: "connection_paused" });

    vi.mocked(connectionsService.getConnection).mockResolvedValue(wooConnection({ sync_products: false }) as never);
    const disabled = await post();
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: "sync_products_disabled" });
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });
});

describe("POST sync/products — plugin mode", () => {
  it("queues a catalogue export for the plugin instead of pulling, and says so", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue(wooConnection({ link_mode: "plugin" }) as never);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(pluginService.enqueuePluginExport).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "catalogue_export");
    expect(wpContent.enqueueContentExport).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID);
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });
});

describe("POST sync/products — REST outcome honesty", () => {
  it("passes a clean result through whole", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, created: 2, updated: 3, total: 5, failed: 0, partial: false });
  });

  it("passes a PARTIAL result through — a sync with failures must not announce success", async () => {
    vi.mocked(syncService.syncProducts).mockResolvedValue({
      ...FULL_OUTCOME,
      total: 10,
      created: 7,
      failed: 2,
      failureIds: ["11", "12"],
      variationFetchFailures: 1,
      variationFailureIds: ["10"],
      taxonomyError: "term_fetch_failed",
      partial: true,
    } as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partial).toBe(true);
    expect(body.failed).toBe(2);
    expect(body.failureIds).toEqual(["11", "12"]);
    expect(body.variationFetchFailures).toBe(1);
    expect(body.taxonomyError).toBe("term_fetch_failed");
  });

  it("keeps a content-sync failure from failing the catalogue, but reports it", async () => {
    vi.mocked(wpContent.syncWpContentRest).mockRejectedValue(new Error("wp/v2 unavailable"));
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, contentError: "wp/v2 unavailable", partial: false });
  });

  it("maps a missing connection to 404 and sanitizes any other failure to a stable code", async () => {
    vi.mocked(syncService.syncProducts).mockRejectedValue(new Error("not_found"));
    expect((await post()).status).toBe(404);

    vi.mocked(syncService.syncProducts).mockRejectedValue(new Error("no_location"));
    const noLocation = await post();
    expect(noLocation.status).toBe(409);
    expect(await noLocation.json()).toMatchObject({ error: "no_location" });

    vi.mocked(syncService.syncProducts).mockRejectedValue(
      new Error("fetch failed: https://ck_live_SECRET@shop.example.com"),
    );
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "sync_failed" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});
