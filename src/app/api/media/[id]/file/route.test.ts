import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import type { MediaStorageConfig } from "@/lib/media";
import type { MediaAssetRecord as MediaAsset, MediaAssetUsage } from "@/lib/media-service";

vi.mock("@/lib/auth", () => ({
  withTenantScope: <T>(fn: T) => fn,
  requireMember: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  getActiveMediaAssetWithStorageKey: vi.fn(),
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(),
  streamMediaObject: vi.fn(),
  getMediaAssetUsage: vi.fn(),
  mediaAssetUsedByVehicleInLocations: vi.fn(),
}));

vi.mock("@/lib/media-mirror", () => ({
  openMirroredMediaStream: vi.fn(),
}));

vi.mock("@/lib/automotive-access", () => ({
  branchAccessForSession: vi.fn(),
}));

import { GET } from "./route";
import * as auth from "@/lib/auth";
import * as mediaService from "@/lib/media-service";
import * as mediaMirror from "@/lib/media-mirror";
import * as automotiveAccess from "@/lib/automotive-access";

const BID = "11111111-1111-1111-1111-111111111111";
const AID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA = "ab".repeat(32);

function makeStream(chunk: Uint8Array = bytes): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function assetFixture(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: AID,
    folderId: null,
    kind: "image",
    fileName: "latte.png",
    mimeType: "image/png",
    byteSize: bytes.byteLength,
    category: null,
    tags: [],
    aiStatus: "none",
    aiLabels: {},
    variant: "original",
    sourceAssetId: null,
    transformOps: [],
    source: "upload",
    createdByAi: false,
    conversationId: null,
    projectId: null,
    deletedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function emptyUsage(over: Partial<MediaAssetUsage> = {}): MediaAssetUsage {
  return {
    menuItems: [],
    inventoryItems: [],
    expenses: [],
    purchases: [],
    parties: [],
    vehicles: [],
    workspaceDocuments: [],
    transfers: [],
    products: [],
    protectedItems: [],
    hasProtected: false,
    ...over,
  };
}

function asMember(perms: string[]) {
  vi.mocked(auth.requireMember).mockResolvedValue({
    session: { sub: "u1", email: "u@test.com", role: "staff", businessId: BID } as never,
    membership: { id: "m1", role: "staff", permissions: new Set(perms) } as never,
    error: null,
  });
}

function call(headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(`http://localhost:3000/api/media/${AID}/file`, { headers }),
    { params: Promise.resolve({ id: AID }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({} as MediaStorageConfig);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.getActiveMediaAssetWithStorageKey).mockResolvedValue({
    asset: assetFixture(),
    storageKey: `media/${BID}/2026-06/${AID}.png`,
    sha256: SHA,
  });
  vi.mocked(mediaService.streamMediaObject).mockImplementation(async (_bid, _key, _cfg, opts) => {
    const slice = opts?.range ? bytes.subarray(opts.range.start, opts.range.end + 1) : bytes;
    return {
      stream: makeStream(slice),
      status: opts?.range ? 206 : 200,
      contentLength: slice.byteLength,
      contentRange: opts?.range ? `bytes ${opts.range.start}-${opts.range.end}/${bytes.byteLength}` : null,
    };
  });
});

describe("GET /api/media/[id]/file — authorize-before-byte-read & streaming Range contract", () => {
  it("a media.view holder reads any active asset without consulting usage at all", async () => {
    asMember([PERMISSIONS.mediaView]);

    const res = await call();
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(mediaService.getMediaAssetUsage).not.toHaveBeenCalled();
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
  });

  it("P0 #1: authorizes BEFORE reading S3 or mirror bytes when an unauthorized member requests an unused asset", async () => {
    asMember([PERMISSIONS.menuView]);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(emptyUsage());

    const res = await call();
    expect(res.status).toBe(403);
    expect(mediaService.streamMediaObject).not.toHaveBeenCalled();
    expect(mediaMirror.openMirroredMediaStream).not.toHaveBeenCalled();
  });

  it("P0 #1: refuses documents to non-media.view members BEFORE reading S3 or mirror bytes", async () => {
    asMember([PERMISSIONS.menuView]);
    vi.mocked(mediaService.getActiveMediaAssetWithStorageKey).mockResolvedValueOnce({
      asset: assetFixture({ kind: "document", mimeType: "application/pdf", fileName: "spec.pdf" }),
      storageKey: `media/${BID}/2026-06/${AID}.pdf`,
      sha256: SHA,
    });

    const res = await call();
    expect(res.status).toBe(403);
    expect(mediaService.getMediaAssetUsage).not.toHaveBeenCalled();
    expect(mediaService.streamMediaObject).not.toHaveBeenCalled();
    expect(mediaMirror.openMirroredMediaStream).not.toHaveBeenCalled();
  });

  it("P0 #2: returns 404 immediately for soft-deleted/missing assets without touching S3 or mirror", async () => {
    asMember([PERMISSIONS.mediaView]);
    vi.mocked(mediaService.getActiveMediaAssetWithStorageKey).mockResolvedValueOnce(null);

    const res = await call();
    expect(res.status).toBe(404);
    expect(mediaService.streamMediaObject).not.toHaveBeenCalled();
    expect(mediaMirror.openMirroredMediaStream).not.toHaveBeenCalled();
  });

  it("a menu.view-only member reads an image a menu item uses", async () => {
    asMember([PERMISSIONS.menuView]);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(
      emptyUsage({ menuItems: [{ id: "mi1", name: "لته" }] }),
    );
    expect((await call()).status).toBe(200);
  });

  it("an inventory.view-only member reads images used by inventory items, retail products, or draft purchases", async () => {
    asMember([PERMISSIONS.inventoryView]);
    vi.mocked(mediaService.getMediaAssetUsage)
      .mockResolvedValueOnce(emptyUsage({ inventoryItems: [{ id: "ii1", name: "شیر" }] }))
      .mockResolvedValueOnce(emptyUsage({ products: [{ id: "prod1", name: "پیراهن نخی" }] }))
      .mockResolvedValueOnce(emptyUsage({ purchases: [{ id: "pur1", name: "خرید خرده‌فروشی" }] }));

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
  });

  it("parties.view and ledger.view inline usage exceptions work cleanly", async () => {
    asMember([PERMISSIONS.partiesView]);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(
      emptyUsage({ parties: [{ id: "pty1", name: "تأمین‌کننده" }] }),
    );
    expect((await call()).status).toBe(200);

    asMember([PERMISSIONS.ledgerView]);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValueOnce(
      emptyUsage({ expenses: [{ id: "exp1", name: "قبض برق" }] }),
    );
    expect((await call()).status).toBe(200);
  });

  it("vehicles.view renders only assets attached to a vehicle in the member's allowed branches without reading bytes when disallowed", async () => {
    asMember([PERMISSIONS.vehiclesView]);
    vi.mocked(mediaService.getMediaAssetUsage)
      .mockResolvedValueOnce(emptyUsage({ vehicles: [{ id: "veh1", name: "پژو ۲۰۷" }] }))
      .mockResolvedValueOnce(emptyUsage({ vehicles: [{ id: "veh1", name: "پژو ۲۰۷" }] }));
    vi.mocked(automotiveAccess.branchAccessForSession)
      .mockResolvedValueOnce({ activeLocationId: "loc-1", allowedLocationIds: ["loc-1"] })
      .mockResolvedValueOnce({ activeLocationId: "loc-2", allowedLocationIds: ["loc-2"] });
    vi.mocked(mediaService.mediaAssetUsedByVehicleInLocations)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    expect((await call()).status).toBe(200);
    expect(mediaService.streamMediaObject).toHaveBeenCalledTimes(1);

    const denied = await call();
    expect(denied.status).toBe(403);
    // Denied vehicle branch did NOT trigger a second S3 stream read
    expect(mediaService.streamMediaObject).toHaveBeenCalledTimes(1);
  });

  it("P1 #6: streams 206 Partial Content with Content-Range for valid Range headers and 416 for unsatisfiable ranges", async () => {
    asMember([PERMISSIONS.mediaView]);

    const partial = await call({ range: "bytes=0-3" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect(partial.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.subarray(0, 4));

    const badRange = await call({ range: "bytes=50-100" });
    expect(badRange.status).toBe(416);
    expect(badRange.headers.get("Content-Range")).toBe(`bytes */${bytes.byteLength}`);
  });

  it("serves checksum-verified local mirror stream when S3 lacks the object, or 404s when neither has it", async () => {
    asMember([PERMISSIONS.mediaView]);
    vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(false);
    vi.mocked(mediaMirror.openMirroredMediaStream)
      .mockResolvedValueOnce({
        asset: { kind: "image", fileName: "latte.png", mimeType: "image/png", byteSize: bytes.byteLength, sha256: SHA },
        stream: makeStream(bytes),
        contentLength: bytes.byteLength,
      })
      .mockResolvedValueOnce(null);

    const fromMirror = await call();
    expect(fromMirror.status).toBe(200);
    expect(new Uint8Array(await fromMirror.arrayBuffer())).toEqual(bytes);

    const missing = await call();
    expect(missing.status).toBe(404);
  });
});
