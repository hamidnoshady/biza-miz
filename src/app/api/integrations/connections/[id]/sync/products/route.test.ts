/**
 * Issue #944 / OVR-04, OVR-08 — «همگام‌سازی محصولات» answers with a structured
 * result the overview can word honestly: REST full success, REST partial
 * (catalogue ok, WordPress content pull failed), plugin queued (with job ids
 * and any substep the plugin cannot apply), and the 409s for a disabled
 * flag, a paused store and a plugin that never advertised the job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as pluginService from "@/lib/integrations/plugin-service";
import * as syncService from "@/lib/integrations/sync-service";
import * as contentService from "@/lib/integrations/wp-content-service";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAnyPermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
// The route resolves the store through the branch-scoped accessor (live
// branch scope, #934); `wooClientFor` still comes from connections-service.
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({
  wooClientFor: vi.fn(() => ({})),
}));
vi.mock("@/lib/integrations/plugin-service", () => ({ enqueuePluginExport: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ syncProducts: vi.fn() }));
vi.mock("@/lib/integrations/wp-content-service", () => ({
  enqueueContentExport: vi.fn(),
  syncWpContentRest: vi.fn(),
}));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "u1", role: "manager" };
const ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = () => new Request(`http://localhost/api/integrations/connections/${ID}/sync/products`, { method: "POST" });

const REST = {
  id: ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  status: "active",
  link_mode: "rest_api",
  sync_products: true,
  plugin_capabilities: null,
};
const PLUGIN = { ...REST, link_mode: "plugin", plugin_capabilities: { jobTypes: ["catalogue_export", "content_export"] } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(REST as never);
  vi.mocked(syncService.syncProducts).mockResolvedValue({ created: 2, updated: 3 } as never);
  vi.mocked(contentService.syncWpContentRest).mockResolvedValue({ posts: 1 } as never);
  vi.mocked(pluginService.enqueuePluginExport).mockResolvedValue({ jobId: "job-cat" });
  vi.mocked(contentService.enqueueContentExport).mockResolvedValue({ jobId: "job-content" });
});

describe("POST /api/integrations/connections/[id]/sync/products", () => {
  it("asks for the WP sync ability (woocommerce.sync or integrations.manage), any-of", async () => {
    await POST(req(), ctx);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage);
  });

  it("returns the guard's denial untouched", async () => {
    const denial = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({ session: null, error: denial } as never);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });

  it("REST full success is result: completed with the counts", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 2, updated: 3, result: "completed" });
  });

  it("REST catalogue ok + content pull failed is result: partial, never a clean success", async () => {
    vi.mocked(contentService.syncWpContentRest).mockRejectedValueOnce(new Error("HTTP 401 on /wp-json/wp/v2/posts"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result).toBe("partial");
    expect(body.contentError).toBe("HTTP 401 on /wp-json/wp/v2/posts");
    expect(body.failedSteps).toEqual([{ step: "content", error: "HTTP 401 on /wp-json/wp/v2/posts" }]);
    expect(body.created).toBe(2);
  });

  it("REST catalogue failure is a 502 with a stable code — raw store errors never leak (#943)", async () => {
    vi.mocked(syncService.syncProducts).mockRejectedValueOnce(new Error("fetch failed: https://ck_live_SECRET@shop.example.com"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "sync_failed" });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("a PARTIAL catalogue outcome passes through whole — failures must not announce success (#943)", async () => {
    vi.mocked(syncService.syncProducts).mockResolvedValueOnce({
      created: 7, updated: 0, skipped: 0, variations: 1, containers: 0, total: 10,
      failed: 2, failureIds: ["11", "12"], variationFetchFailures: 1, variationFailureIds: ["10"],
      missingRemotely: 0, taxonomyError: "term_fetch_failed", partial: true,
    } as never);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partial).toBe(true);
    expect(body.failed).toBe(2);
    expect(body.failureIds).toEqual(["11", "12"]);
    expect(body.variationFetchFailures).toBe(1);
    expect(body.taxonomyError).toBe("term_fetch_failed");
  });

  it("maps not_found to 404 and no_location to 409 (#943)", async () => {
    vi.mocked(syncService.syncProducts).mockRejectedValueOnce(new Error("not_found"));
    expect((await POST(req(), ctx)).status).toBe(404);
    vi.mocked(syncService.syncProducts).mockRejectedValueOnce(new Error("no_location"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_location" });
  });

  it("plugin mode queues catalogue + content and answers result: queued with both job ids", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce(PLUGIN as never);
    const res = await POST(req(), ctx);
    expect(await res.json()).toEqual({ ok: true, queued: true, result: "queued", jobIds: ["job-cat", "job-content"] });
    expect(pluginService.enqueuePluginExport).toHaveBeenCalledWith(SESSION.businessId, ID, "catalogue_export");
    expect(contentService.enqueueContentExport).toHaveBeenCalledWith(SESSION.businessId, ID);
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });

  it("a legacy plugin (no advertised content_export) gets the catalogue queued and content named as skipped, not stranded", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...PLUGIN, plugin_capabilities: null } as never);
    const res = await POST(req(), ctx);
    const body = await res.json();
    expect(body.result).toBe("queued");
    expect(body.jobIds).toEqual(["job-cat"]);
    expect(body.skippedSteps).toEqual([{ step: "content", reason: "plugin_job_unsupported" }]);
    expect(contentService.enqueueContentExport).not.toHaveBeenCalled();
  });

  it("a plugin that cannot apply catalogue_export is refused with 409 plugin_job_unsupported", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...PLUGIN, plugin_capabilities: { jobTypes: ["stock"] } } as never);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "plugin_job_unsupported" });
    expect(pluginService.enqueuePluginExport).not.toHaveBeenCalled();
  });

  it("409 for a disabled products flag and for a paused store", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...REST, sync_products: false } as never);
    expect((await POST(req(), ctx)).status).toBe(409);
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...REST, status: "paused" } as never);
    const paused = await POST(req(), ctx);
    expect(paused.status).toBe(409);
    expect(await paused.json()).toEqual({ ok: false, error: "connection_paused" });
    expect(syncService.syncProducts).not.toHaveBeenCalled();
  });

  it("404 for a missing connection or a non-WooCommerce provider (provider validation preserved)", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce(null as never);
    expect((await POST(req(), ctx)).status).toBe(404);
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...REST, provider: "holoo" } as never);
    expect((await POST(req(), ctx)).status).toBe(404);
    // Always looked up inside the caller's business — never by id alone.
    expect(connectionAccess.getAccessibleConnection).toHaveBeenCalledWith(SESSION, ID);
  });
});
