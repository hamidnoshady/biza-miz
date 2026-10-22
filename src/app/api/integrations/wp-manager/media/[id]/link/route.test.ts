import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({ auth: vi.fn(), connection: vi.fn(), query: vi.fn(), existing: vi.fn(), record: vi.fn(), confirm: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePermissions: m.auth, withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/db", () => ({ query: m.query, withTenantTransaction: async (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: m.connection }));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: m.audit }));
vi.mock("@/lib/media-service", () => ({ getWordPressMediaMapping: m.existing, recordWordPressMediaPush: m.record, confirmWordPressMediaSync: m.confirm }));
import { POST } from "./route";
const connectionId = "11111111-1111-4111-8111-111111111111", assetId = "22222222-2222-4222-8222-222222222222";
const req = (extra = {}) => new Request("http://test/api", { method: "POST", body: JSON.stringify({ connectionId, assetId, ...extra }) });
const context = { params: Promise.resolve({ id: "42" }) };
beforeEach(() => {
  vi.resetAllMocks(); m.auth.mockResolvedValue({ session: { businessId: "tenant" } });
  m.connection.mockResolvedValue({ provider: "woocommerce", status: "active" });
  m.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: assetId }] }).mockResolvedValueOnce({ rows: [{ media_url: "https://store.example/image.png", status: "inherit" }] }).mockResolvedValue({ rows: [] });
  m.confirm.mockResolvedValue(true);
});
describe("intentional canonical/remote link (never a file copy)", () => {
  it("requires both canonical permissions and remote management before database access", async () => {
    m.auth.mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) });
    expect((await POST(req(), context)).status).toBe(403); expect(m.query).not.toHaveBeenCalled();
    expect(m.auth.mock.calls[0]).toHaveLength(3);
  });
  it("rejects malformed identities and foreign connections", async () => {
    expect((await POST(req({ assetId: "-".repeat(36) }), context)).status).toBe(400);
    m.connection.mockResolvedValue(null);
    expect((await POST(req(), context)).status).toBe(404); expect(m.query).not.toHaveBeenCalled();
    expect(m.connection).toHaveBeenCalledWith(expect.objectContaining({ businessId: "tenant" }), connectionId);
  });
  it("serializes with remote lifecycle, links tenant-scoped identities, and does not enqueue/download/copy bytes", async () => {
    expect((await POST(req(), context)).status).toBe(200);
    expect(m.query.mock.calls[0][1]).toEqual([`wp-media-connection:${connectionId}`]);
    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({ businessId: "tenant", connectionId, mediaAssetId: assetId }));
    expect(m.confirm).toHaveBeenCalledWith(expect.any(String), "42", "https://store.example/image.png", { businessId: "tenant", connectionId });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "media.remote_linked", businessId: "tenant" }));
    expect(m.query.mock.calls.every(([sql]) => !sql.includes("integration_outbox_events"))).toBe(true);
  });
  it("coalesces repeated links but never replaces pending or different remote mappings", async () => {
    m.existing.mockResolvedValue({ status: "synced", wpMediaId: "42" });
    expect((await POST(req(), context)).status).toBe(200); expect(m.record).not.toHaveBeenCalled();
  });
  it("refuses to overwrite a pending operation", async () => {
    m.existing.mockResolvedValue({ status: "pending", wpMediaId: null });
    expect((await POST(req(), context)).status).toBe(409); expect(m.record).not.toHaveBeenCalled();
  });
  it("rejects missing canonical/remote assets and executable remote URLs", async () => {
    m.query.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: assetId }] }).mockResolvedValueOnce({ rows: [{ media_url: "javascript:alert(1)", status: "inherit" }] });
    expect((await POST(req(), context)).status).toBe(404); expect(m.record).not.toHaveBeenCalled();
  });
  it("prevents associating one remote identity with a second canonical asset", async () => {
    m.query.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: assetId }] }).mockResolvedValueOnce({ rows: [{ media_url: "https://store.example/image.png", status: "inherit" }] }).mockResolvedValueOnce({ rows: [{ id: "other-mapping" }] });
    expect((await POST(req(), context)).status).toBe(409); expect(m.record).not.toHaveBeenCalled();
  });
});
