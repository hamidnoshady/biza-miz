import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ list: vi.fn(), count: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requirePermission: async () => ({ session: { businessId: "tenant" } }), withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: async () => ({ provider: "woocommerce" }) }));
vi.mock("@/lib/db", () => ({ query: m.query }));
vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: async () => ({ provider: "woocommerce" }), wooClientFor: vi.fn() }));
vi.mock("@/lib/integrations/wp-content-service", () => ({ listWpContent: m.list, countWpContent: m.count, enqueueContentExport: vi.fn(), syncWpContentRest: vi.fn() }));
import { GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const asOf = "2026-10-21T00:00:00.123Z";
function request(changes: Record<string, unknown>) {
  const cursor = Buffer.from(JSON.stringify({ scope: JSON.stringify([id, "", null]), asOf, ...changes })).toString("base64url");
  return new Request(`http://test/api?connectionId=${id}&type=attachment&cursorMode=1&cursor=${cursor}`);
}
beforeEach(() => { vi.resetAllMocks(); m.list.mockResolvedValue([]); m.count.mockResolvedValue(0); m.query.mockResolvedValue({ rows: [{ last_media_sync_at: "media-stamp" }] }); });
describe("stable media cursor validation", () => {
  it.each([
    { asOf: "0" }, { asOf: "2026-02-30T00:00:00.123Z" }, { asOf: 0 },
    { after: { id: "-".repeat(36), createdAt: asOf } },
    { after: { id, createdAt: "2026-01-01" } }, { scope: "other-store" },
  ])("rejects invalid date/UUID/scope without a SQL cast: %j", async (changes) => {
    expect((await GET(request(changes))).status).toBe(400); expect(m.list).not.toHaveBeenCalled();
  });
  it("preserves six-digit SQL timestamp positions and uses only the media watermark", async () => {
    const after = { id, createdAt: "2026-10-20T23:00:00.123456Z" };
    const response = await GET(request({ after }));
    expect(response.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith("tenant", id, expect.objectContaining({ after, asOf }));
    expect((await response.json()).syncedAt).toBe("media-stamp");
  });
});
