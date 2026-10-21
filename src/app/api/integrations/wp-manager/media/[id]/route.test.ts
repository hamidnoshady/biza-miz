import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({ auth: vi.fn(), connection: vi.fn(), query: vi.fn(), rate: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePermission: m.auth, withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/db", () => ({ query: m.query, withTenantTransaction: async (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: m.connection }));
vi.mock("@/lib/integrations/wp-media-rate-limit", () => ({ allowWpMediaCreation: m.rate }));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: m.audit }));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ id: "42" }) };
const req = (extra: Record<string, unknown> = {}) => new Request("http://test/api?connectionId=site", { method: "POST", body: JSON.stringify({ connectionId: "site", action: "update", revision: "10", title: "New", ...extra }) });
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ session: { businessId: "tenant" }, error: null });
  m.connection.mockResolvedValue({ id: "site", provider: "woocommerce", link_mode: "plugin", status: "active", plugin_capabilities: { jobTypes: ["media_update"] } });
  m.rate.mockResolvedValue(true); m.query.mockResolvedValue({ rows: [{ id: "job" }] });
});
describe("attachment metadata/lifecycle command API", () => {
  it("queues metadata as media_update rather than media_create, with immutable identity and scoped audit", async () => {
    expect((await POST(req(), context)).status).toBe(202);
    const [sql, values] = m.query.mock.calls[0];
    expect(sql).toContain("'media_update'"); expect(values.slice(0, 2)).toEqual(["tenant", "site"]);
    expect(JSON.parse(values[3])).toMatchObject({ action: "update", attachment_id: "42", fields: { title: "New" }, expected_revision: "10" });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ businessId: "tenant", remoteId: "42", action: "media.update_queued" }));
  });
  it.each(["trash", "destroy", "replace"])("does not allow an unconfirmed/unsupported destructive %s", async (action) => {
    expect((await POST(req({ action }), context)).status).toBe(400); expect(m.query).not.toHaveBeenCalled();
  });
  it("requires explicit remote confirmation and leaves canonical media alone", async () => {
    expect((await POST(req({ action: "trash", confirmRemote: true }), context)).status).toBe(202);
    expect(m.query.mock.calls[0][0]).not.toContain("media_assets");
  });
  it("rejects a stale/missing revision before queuing edits", async () => {
    expect((await POST(req({ revision: undefined }), context)).status).toBe(409); expect(m.query).not.toHaveBeenCalled();
  });
  it("enforces permission before connection or database reads", async () => {
    m.auth.mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) });
    expect((await POST(req(), context)).status).toBe(403); expect(m.connection).not.toHaveBeenCalled();
  });
  it("rejects a foreign connection and a paused connection", async () => {
    m.connection.mockResolvedValueOnce(null);
    expect((await POST(req(), context)).status).toBe(404);
    m.connection.mockResolvedValueOnce({ provider: "woocommerce", status: "paused" });
    expect((await POST(req(), context)).status).toBe(409);
    expect(m.query).not.toHaveBeenCalled();
  });
  it("rate-limits queued operations across sites", async () => {
    m.rate.mockResolvedValue(false); const response = await POST(req(), context);
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60"); expect(m.query).not.toHaveBeenCalled();
  });
  it("validates metadata size and ignores fields outside the allowlist", async () => {
    expect((await POST(req({ title: "x".repeat(201) }), context)).status).toBe(400);
    expect((await POST(req({ url: "http://127.0.0.1/", ID: "other" }), context)).status).toBe(202);
    expect(m.query.mock.calls[0][1][3]).not.toContain("127.0.0.1");
  });
  it("does not expose executable mirror URLs or raw queue payloads", async () => {
    m.query.mockResolvedValueOnce({ rows: [{ title: "title", media_url: "javascript:alert(1)", payload: { content: "desc" } }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await (await GET(new Request("http://test/api?connectionId=site"), context)).json();
    expect(result.attachment.url).toBeNull(); expect(result.jobs).toEqual([]);
  });
});
