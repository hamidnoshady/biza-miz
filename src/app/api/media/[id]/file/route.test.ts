import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as mediaService from "@/lib/media-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

/**
 * The named platform bug this route exists to fix: "browse the Media
 * Library" (`media.view`, owner/manager/admin only) and "render a photo an
 * application record you're already authorized to see" are DIFFERENT
 * permissions. A cashier/waiter/kitchen member holds `menu.view` but never
 * `media.view` — they must still be able to render a menu item's own photo.
 * The same shape now extends to `inventory.view` (an inventory item's photo,
 * and — as of migration 0179 — a draft purchase's own scanned invoice photo),
 * `ledger.view` (as of migration 0177, an expense's receipt photo), and
 * `parties.view` (as of migration 0181, a party's own uploaded avatar) —
 * each gated on `getMediaAssetUsage` actually naming THIS asset for a record
 * that permission covers, never a blanket grant.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireMember: vi.fn(), withTenantScope: (h: (...a: unknown[]) => Promise<Response>) => h };
});

vi.mock("@/lib/media-service", () => ({
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(() => true),
  readMediaObject: vi.fn(),
  getMediaAssetUsage: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "member" };
const IMAGE_ASSET = { id: "asset-1", kind: "image" as const, mimeType: "image/png", fileName: "photo.png" };
const DOC_ASSET = { id: "asset-2", kind: "document" as const, mimeType: "application/pdf", fileName: "doc.pdf" };
const EMPTY_USAGE = { menuItems: [], inventoryItems: [], expenses: [], purchases: [], parties: [] };

function membershipWith(...perms: string[]) {
  return { permissions: new Set(perms) };
}

function ctx(id = "asset-1") {
  return { params: Promise.resolve({ id }) };
}

function req(): NextRequest {
  return new Request("http://localhost:3000/api/media/asset-1/file") as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({} as never);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.readMediaObject).mockResolvedValue({ asset: IMAGE_ASSET, bytes: Buffer.from("x") } as never);
  vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE as never);
});

describe("GET /api/media/[id]/file — usage-based permission model", () => {
  it("a media.view holder reads any asset without consulting usage at all", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.mediaView),
      error: null,
    } as never);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(mediaService.getMediaAssetUsage).not.toHaveBeenCalled();
  });

  it("a menu.view-only member reads an image a menu item uses, but is refused one it doesn't", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.menuView),
      error: null,
    } as never);

    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [{ id: "mi-1", name: "اسپرسو" }],
      inventoryItems: [],
      expenses: [],
      purchases: [],
      parties: [],
    } as never);
    const used = await GET(req(), ctx());
    expect(used.status).toBe(200);

    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE as never);
    const unused = await GET(req(), ctx());
    expect(unused.status).toBe(403);
  });

  it("an inventory.view-only member reads an image an inventory item uses", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.inventoryView),
      error: null,
    } as never);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [],
      inventoryItems: [{ id: "ii-1", name: "شکر" }],
      expenses: [],
      purchases: [],
      parties: [],
    } as never);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
  });

  it("migration 0179: an inventory.view-only member reads an image a draft purchase recorded as its invoice", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.inventoryView),
      error: null,
    } as never);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [],
      inventoryItems: [],
      expenses: [],
      purchases: [{ id: "po-1", name: "فاکتور تأمین‌کننده" }],
      parties: [],
    } as never);
    const used = await GET(req(), ctx());
    expect(used.status).toBe(200);

    // Same permission as an inventory item's own photo, but never a blanket
    // grant — it must be THIS asset a purchase actually points at.
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE as never);
    const unused = await GET(req(), ctx());
    expect(unused.status).toBe(403);
  });

  it("migration 0181: a parties.view-only member reads an image a party recorded as its avatar", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.partiesView),
      error: null,
    } as never);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [],
      inventoryItems: [],
      expenses: [],
      purchases: [],
      parties: [{ id: "party-1", name: "شرکت آزمایشی" }],
    } as never);
    const used = await GET(req(), ctx());
    expect(used.status).toBe(200);

    // The permission alone is not a blanket grant — it must be THIS asset.
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE as never);
    const unused = await GET(req(), ctx());
    expect(unused.status).toBe(403);
  });

  it("migration 0177: a ledger.view-only member reads an image an expense recorded as its receipt", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.ledgerView),
      error: null,
    } as never);

    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [],
      inventoryItems: [],
      expenses: [{ id: "exp-1", name: "خرید ملزومات" }],
      purchases: [],
      parties: [],
    } as never);
    const used = await GET(req(), ctx());
    expect(used.status).toBe(200);

    // The permission alone is not a blanket grant — it must be THIS asset.
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue(EMPTY_USAGE as never);
    const unused = await GET(req(), ctx());
    expect(unused.status).toBe(403);
  });

  it("a menu.view holder can never read a document, even one a menu item somehow referenced", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.menuView),
      error: null,
    } as never);
    vi.mocked(mediaService.readMediaObject).mockResolvedValue({ asset: DOC_ASSET, bytes: Buffer.from("x") } as never);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    // Documents never consult usage — "used by a catalogue item" does not
    // extend to reading a raw file kind that isn't image/video.
    expect(mediaService.getMediaAssetUsage).not.toHaveBeenCalled();
  });

  it("a member with none of the usage-granting permissions is refused an otherwise-used image", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(),
      error: null,
    } as never);
    vi.mocked(mediaService.getMediaAssetUsage).mockResolvedValue({
      menuItems: [{ id: "mi-1", name: "اسپرسو" }],
      inventoryItems: [],
      expenses: [],
      purchases: [],
      parties: [],
    } as never);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
  });

  it("404s when the asset does not exist and 503s when storage is not configured", async () => {
    vi.mocked(auth.requireMember).mockResolvedValue({
      session: SESSION,
      membership: membershipWith(PERMISSIONS.mediaView),
      error: null,
    } as never);

    vi.mocked(mediaService.readMediaObject).mockResolvedValue(null);
    const missing = await GET(req(), ctx());
    expect(missing.status).toBe(404);

    vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(false);
    const notReady = await GET(req(), ctx());
    expect(notReady.status).toBe(503);
  });
});
