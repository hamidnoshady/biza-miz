import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/cms/website-service";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

/**
 * The CMS edit modal's entry route. What matters: it needs `cms.content_manage`, it names
 * only a collection and an optional uuid, and `canPublish` comes from the *session's*
 * permissions — never from the request body.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/cms/website-service", () => ({ createCmsEmbedSession: vi.fn() }));

const DOC = "22222222-2222-4222-8222-222222222222";

function allow(permissions: string[]) {
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: { businessId: "biz-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  } as never);
}

const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/cms/website/embed", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.createCmsEmbedSession).mockResolvedValue({ ok: true, data: { url: "https://cms.test/api/embed/enter?code=abc" } });
});

describe("POST /api/cms/website/embed", () => {
  it("requires cms.content_manage", async () => {
    const denied = new Response(null, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await call({ collection: "posts" })).status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.cmsContentManage);
    expect(service.createCmsEmbedSession).not.toHaveBeenCalled();
  });

  it("returns only the url, uncached", async () => {
    allow([PERMISSIONS.cmsContentManage]);
    const res = await call({ collection: "pages", id: DOC });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ url: "https://cms.test/api/embed/enter?code=abc" });
    expect(service.createCmsEmbedSession).toHaveBeenCalledWith("biz-1", {
      collection: "pages",
      id: DOC,
      canPublish: false,
    });
  });

  it("derives canPublish from the session's cms.publish, never from the body", async () => {
    allow([PERMISSIONS.cmsContentManage, PERMISSIONS.cmsPublish]);
    await call({ collection: "posts" });
    expect(service.createCmsEmbedSession).toHaveBeenLastCalledWith("biz-1", {
      collection: "posts",
      id: undefined,
      canPublish: true,
    });

    allow([PERMISSIONS.cmsContentManage]);
    await call({ collection: "posts", canPublish: true });
    expect(service.createCmsEmbedSession).toHaveBeenLastCalledWith("biz-1", {
      collection: "posts",
      id: undefined,
      canPublish: false,
    });
  });

  it("rejects an unknown collection, a non-uuid id and a bad body", async () => {
    allow([PERMISSIONS.cmsContentManage]);
    expect((await call({ collection: "users" })).status).toBe(400);
    expect((await call({ collection: "posts", id: "../etc" })).status).toBe(400);
    expect((await call({ collection: "posts", id: 7 })).status).toBe(400);
    expect((await call("{nope")).status).toBe(400);
    expect(service.createCmsEmbedSession).not.toHaveBeenCalled();
  });

  it("maps CMS failures to honest statuses", async () => {
    allow([PERMISSIONS.cmsContentManage]);
    for (const [error, status] of [
      ["not_found", 404],
      ["not_connected", 409],
      ["cms_not_configured", 503],
      ["cms_old_version", 502],
      ["cms_error", 400],
    ] as const) {
      vi.mocked(service.createCmsEmbedSession).mockResolvedValueOnce({ ok: false, error });
      const res = await call({ collection: "posts" });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });
});
