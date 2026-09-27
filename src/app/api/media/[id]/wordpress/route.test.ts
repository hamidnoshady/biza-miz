import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as audit from "@/lib/integrations/audit";
import * as mediaService from "@/lib/media-service";
import { GET, POST } from "./route";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/integrations/connections-service", () => ({
  listConnections: vi.fn(),
}));

vi.mock("@/lib/integrations/audit", () => ({
  writeIntegrationAudit: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  getMediaAsset: vi.fn(),
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(),
  listWordPressMappingsForAsset: vi.fn(),
  readMediaObjectDownloadUrl: vi.fn(),
  recordWordPressMediaPush: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

const IMAGE_ASSET = { id: ASSET_ID, kind: "image", fileName: "product-shot.png" };

const PLUGIN_CONNECTION_ROW = {
  id: CONNECTION_ID,
  provider: "woocommerce",
  link_mode: "plugin",
  status: "active",
  plugin_capabilities: { jobTypes: ["stock", "price", "media_create"] },
};

function ctx(id = ASSET_ID) {
  return { params: Promise.resolve({ id }) };
}

function req(): NextRequest {
  return new Request(`http://localhost:3000/api/media/${ASSET_ID}/wordpress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId: CONNECTION_ID }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(mediaService.getMediaAsset).mockResolvedValue(IMAGE_ASSET as never);
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({} as never);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.readMediaObjectDownloadUrl).mockResolvedValue({
    asset: IMAGE_ASSET,
    url: "https://bucket.example.com/media/product-shot.png?X-Amz-Signature=abc",
  } as never);
  vi.mocked(mediaService.recordWordPressMediaPush).mockResolvedValue({
    id: "mapping-1",
    mediaAssetId: ASSET_ID,
    connectionId: CONNECTION_ID,
    operationId: "op",
    wpMediaId: null,
    wpUrl: null,
    status: "pending",
    lastError: null,
    createdAt: "now",
    syncedAt: null,
  } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [PLUGIN_CONNECTION_ROW] } as never);
});

describe("GET /api/media/[id]/wordpress", () => {
  it("404s when the asset does not exist in this tenant", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);
    const res = await GET((new Request("http://x") as unknown as NextRequest), ctx());
    expect(res.status).toBe(404);
  });

  it("lists only WooCommerce connections, each with its push eligibility and current mapping", async () => {
    vi.mocked(connectionsService.listConnections).mockResolvedValue([
      {
        id: CONNECTION_ID,
        name: "فروشگاه من",
        provider: "woocommerce",
        linkMode: "plugin",
        status: "active",
        pluginCapabilities: { jobTypes: ["media_create"] },
      },
      { id: "other", name: "درگاه دیگر", provider: "some_other_provider", linkMode: "plugin", status: "active", pluginCapabilities: null },
    ] as never);
    vi.mocked(mediaService.listWordPressMappingsForAsset).mockResolvedValue([
      { id: "m1", mediaAssetId: ASSET_ID, connectionId: CONNECTION_ID, operationId: "op", wpMediaId: "9", wpUrl: "https://x", status: "synced", lastError: null, createdAt: "t", syncedAt: "t" },
    ] as never);

    const res = await GET((new Request("http://x") as unknown as NextRequest), ctx());
    const body = await res.json();
    expect(body.connections).toHaveLength(1); // the non-woocommerce provider is filtered out
    expect(body.connections[0]).toMatchObject({ id: CONNECTION_ID, canPush: true });
    expect(body.connections[0].mapping.status).toBe("synced");
  });

  it("marks canPush false for a paused connection, a REST connection, or a plugin without media_create", async () => {
    vi.mocked(connectionsService.listConnections).mockResolvedValue([
      { id: "a", name: "a", provider: "woocommerce", linkMode: "plugin", status: "paused", pluginCapabilities: { jobTypes: ["media_create"] } },
      { id: "b", name: "b", provider: "woocommerce", linkMode: "rest_api", status: "active", pluginCapabilities: null },
      { id: "c", name: "c", provider: "woocommerce", linkMode: "plugin", status: "active", pluginCapabilities: { jobTypes: ["stock"] } },
    ] as never);
    vi.mocked(mediaService.listWordPressMappingsForAsset).mockResolvedValue([]);

    const res = await GET((new Request("http://x") as unknown as NextRequest), ctx());
    const body = await res.json();
    expect(body.connections.every((c: { canPush: boolean }) => c.canPush === false)).toBe(true);
  });
});

describe("POST /api/media/[id]/wordpress", () => {
  it("returns 400 when connectionId is missing", async () => {
    const res = await POST(
      (new Request("http://x", { method: "POST", body: JSON.stringify({}) }) as unknown as NextRequest),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_connection" });
  });

  it("404s when the asset does not exist", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("refuses a document — WordPress push is scoped to image/video", async () => {
    vi.mocked(mediaService.getMediaAsset).mockResolvedValue({ ...IMAGE_ASSET, kind: "document" } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_kind" });
  });

  it("404s for a connection outside the tenant or of another provider", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("answers 409 connection_paused for a paused connection", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ ...PLUGIN_CONNECTION_ROW, status: "paused" }] } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "connection_paused" });
  });

  it("refuses REST connections — no session to fetch a signed URL back through, and no sideload endpoint anyway", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ ...PLUGIN_CONNECTION_ROW, link_mode: "rest_api" }] } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "media_rest_unsupported" });
  });

  it("refuses a plugin whose handshake never advertised media_create", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ ...PLUGIN_CONNECTION_ROW, plugin_capabilities: null }] } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plugin_media_unsupported" });
  });

  it("503s when the media bucket is not configured", async () => {
    vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(503);
  });

  it("mints a presigned URL, enqueues one media_create job, and records the mapping", async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);

    expect(mediaService.readMediaObjectDownloadUrl).toHaveBeenCalledWith(
      SESSION.businessId,
      ASSET_ID,
      expect.anything(),
      expect.any(Number),
    );

    // second db.query call is the outbox insert (the first was the connection lookup)
    const insertCall = vi.mocked(db.query).mock.calls[1] as [string, unknown[]];
    expect(insertCall[0]).toContain("integration_outbox_events");
    expect(insertCall[0]).toContain("'media_create'");
    expect(insertCall[1][0]).toBe(SESSION.businessId);
    expect(insertCall[1][1]).toBe(CONNECTION_ID);
    const payload = JSON.parse(insertCall[1][3] as string) as Record<string, unknown>;
    expect(payload.url).toContain("X-Amz-Signature");
    expect(payload.title).toBe("product-shot.png");
    const operationId = payload.__operationId as string;
    expect(operationId).toBe(`wp-media:${CONNECTION_ID}:${insertCall[1][2]}`);
    expect(insertCall[1][4]).toBe(operationId);

    expect(mediaService.recordWordPressMediaPush).toHaveBeenCalledWith({
      businessId: SESSION.businessId,
      mediaAssetId: ASSET_ID,
      connectionId: CONNECTION_ID,
      operationId,
    });
    expect(audit.writeIntegrationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "media.wordpress_push_queued", entityType: "media_create" }),
    );
  });

  it("404s when the asset vanished between the tenant check and the presign (deleted mid-request)", async () => {
    vi.mocked(mediaService.readMediaObjectDownloadUrl).mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(mediaService.recordWordPressMediaPush).not.toHaveBeenCalled();
  });
});
