import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { query } from "./db";
import { cmsMediaPreview } from "./cms/website-service";
import { verifyLibraryAttachments } from "./ai-library-attachments";
import { PERMISSIONS } from "./permissions";
import { effectiveAppAvailability } from "./app-availability-service";

vi.mock("./db", () => ({ query: vi.fn() }));
vi.mock("./cms/website-service", () => ({ cmsMediaPreview: vi.fn() }));
vi.mock("./app-availability-service", () => ({ effectiveAppAvailability: vi.fn() }));
const bytes = Buffer.from("iVBORw0KGgo=", "base64");
const attachment = {
  kind: "image" as const, dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  source: { library: "media" as const, id: "11111111-1111-4111-8111-111111111111" },
};
const permissions = new Set([PERMISSIONS.mediaView, PERMISSIONS.cmsView, PERMISSIONS.woocommerceView]);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(effectiveAppAvailability).mockResolvedValue({ website: { usable: true } } as never);
});

describe("library attachment authorization and custody", () => {
  it("refuses website sources when the owning app was disabled", async () => {
    vi.mocked(effectiveAppAvailability).mockResolvedValue({ website: { usable: false } } as never);
    expect(await verifyLibraryAttachments("biz-a", permissions, [{ ...attachment, source: { library: "cms", id: "file-1" } }])).toBe(false);
    expect(cmsMediaPreview).not.toHaveBeenCalled();
  });
  it("rechecks media permission without reading storage", async () => {
    expect(await verifyLibraryAttachments("biz-a", new Set(), [attachment])).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("requires the current tenant row and matching bytes", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    expect(await verifyLibraryAttachments("biz-b", permissions, [attachment])).toBe(false);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["biz-b", attachment.source.id]);
    vi.mocked(query).mockResolvedValue({ rows: [{ sha256: createHash("sha256").update(bytes).digest("hex") }] } as never);
    expect(await verifyLibraryAttachments("biz-a", permissions, [attachment])).toBe(true);
    expect(await verifyLibraryAttachments("biz-a", permissions, [{ ...attachment, dataUrl: "data:image/png;base64,YQ==" }])).toBe(false);
  });
  it("requires a live synced WordPress mapping for the same connection and asset", async () => {
    const wp = { ...attachment, source: { library: "wordpress" as const, id: attachment.source.id, connectionId: "22222222-2222-4222-8222-222222222222", remoteId: "41" } };
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);
    expect(await verifyLibraryAttachments("biz-a", permissions, [wp])).toBe(false);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["biz-a", wp.source.id, wp.source.connectionId, "41"]);
    expect(vi.mocked(query).mock.calls[0][0]).toContain("w.status = 'synced'");
  });
  it("uses the authenticated CMS preview and compares bytes, never a remote URL", async () => {
    vi.mocked(cmsMediaPreview).mockResolvedValue({ ok: true, data: { body: new Uint8Array(bytes).buffer, contentType: "image/png" } });
    const cms = { ...attachment, source: { library: "cms" as const, id: "cms-file-1" } };
    expect(await verifyLibraryAttachments("biz-a", permissions, [cms])).toBe(true);
    expect(cmsMediaPreview).toHaveBeenCalledWith("biz-a", "cms-file-1");
    expect(query).not.toHaveBeenCalled();
  });
});
