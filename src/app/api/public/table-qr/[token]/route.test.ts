import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ resolveTableQrToken: vi.fn() }));

vi.mock("@/lib/table-qr-service", () => ({
  resolveTableQrToken: mocks.resolveTableQrToken,
}));

const token = `tqr_${"a".repeat(32)}`;

function request(query = "", value = token): NextRequest {
  return new NextRequest(`http://localhost/api/public/table-qr/${value}${query}`);
}

const ctx = (value = token) => ({ params: Promise.resolve({ token: value }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/public/table-qr/[token]", () => {
  it("resolves a live print to a display name and the CMS site only", async () => {
    mocks.resolveTableQrToken.mockResolvedValue({
      ok: true,
      siteId: "site-1",
      table: { name: "میز ۴", capacity: 2 },
      location: { name: "کافه مرکزی" },
      serviceMode: "dine_in",
      sessionOpen: false,
    });

    const response = (await GET(request(), ctx())) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      siteId: "site-1",
      table: { name: "میز ۴", capacity: 2 },
      location: { name: "کافه مرکزی" },
      serviceMode: "dine_in",
      sessionOpen: false,
    });
    // No uuid of any kind may appear in the public answer.
    expect(JSON.stringify(body)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(mocks.resolveTableQrToken).toHaveBeenCalledWith(token, { siteId: null });
  });

  it("scopes the resolve to the CMS site it was asked for", async () => {
    mocks.resolveTableQrToken.mockResolvedValue({
      ok: true,
      siteId: "site-1",
      table: { name: "میز ۴", capacity: 2 },
      location: { name: "کافه مرکزی" },
      serviceMode: "dine_in",
      sessionOpen: true,
    });
    await GET(request("?siteId=site-1"), ctx());
    expect(mocks.resolveTableQrToken).toHaveBeenCalledWith(token, { siteId: "site-1" });
  });

  it.each([
    ["unknown_token", 404],
    ["invalid_token", 404],
    ["site_mismatch", 404],
    ["token_rotated", 410],
    ["token_revoked", 410],
    ["table_archived", 410],
    ["table_unavailable", 409],
    ["service_disabled", 403],
  ])("answers %s with %i and no table details", async (reason, status) => {
    mocks.resolveTableQrToken.mockResolvedValue({ ok: false, reason, status });
    const response = (await GET(request("", "not-a-token"), ctx("not-a-token"))) as Response;
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: reason, status });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
