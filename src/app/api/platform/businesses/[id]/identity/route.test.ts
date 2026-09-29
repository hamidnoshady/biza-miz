/**
 * The workspace shell's identity read (issue #755 §11).
 *
 * Two things have to stay true or the duplicate-load regression comes back:
 * the shell must read this endpoint rather than the full business summary, and
 * this endpoint must stay cheap — no counts, no aliases, no industry data.
 * Both are asserted here, the second by reading the SQL the service actually
 * issued, so "someone quietly made it heavy again" fails a test instead of a
 * performance review.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const query = vi.hoisted(() => vi.fn());

vi.mock("@/lib/platform-auth", () => {
  const session = { session: { padmin: "admin-1", role: "support" }, error: null };
  return {
    requirePlatformCapability: vi.fn(async () => session),
    requirePlatformAdmin: vi.fn(async () => session),
    withPlatformScope: (fn: (req: NextRequest, ctx: unknown) => Promise<Response>) => fn,
    platformAudit: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/db", () => ({
  query,
  withoutTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
  getPool: vi.fn(),
}));

const { GET } = await import("./route");

const ctx = { params: Promise.resolve({ id: "biz-1" }) };

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({
    rows: [
      {
        id: "biz-1",
        name: "کافه الفبا",
        slug: "alpha",
        subdomain: "alpha",
        status: "active",
      },
    ],
  });
});

describe("GET /api/platform/businesses/[id]/identity", () => {
  it("answers with the identity alone, for any admin role", async () => {
    const res = await GET(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1/identity"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      business: { id: "biz-1", name: "کافه الفبا", slug: "alpha", subdomain: "alpha", status: "active" },
    });
  });

  it("reads one row with no counts, aliases or industry data", async () => {
    await GET(new NextRequest("http://localhost:3000/api/platform/businesses/biz-1/identity"), ctx);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("FROM businesses");
    // The heavy read is `getBusiness`, whose cost is these correlated sub-selects.
    expect(sql).not.toMatch(/count\(\*\)/i);
    expect(sql).not.toContain("orders");
    expect(sql).not.toContain("locations");
    expect(sql).not.toContain("users");
    expect(sql).not.toContain("subdomain_aliases");
  });

  it("still 401s a caller without a platform session", async () => {
    const { requirePlatformCapability } = await import("@/lib/platform-auth");
    vi.mocked(requirePlatformCapability).mockResolvedValueOnce({
      session: null,
      error: Response.json({ error: "unauthorized" }, { status: 401 }),
    } as never);
    const res = await GET(
      new NextRequest("http://localhost:3000/api/platform/businesses/biz-1/identity"),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("the console shell uses the cheap read", () => {
  it("fetches the identity endpoint, never the full business summary", () => {
    const layout = readFileSync(
      join(process.cwd(), "src", "app", "platform", "layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("/identity");
    expect(layout).not.toMatch(/api\/platform\/businesses\/\$\{openBusinessId\}`/);
  });
});
