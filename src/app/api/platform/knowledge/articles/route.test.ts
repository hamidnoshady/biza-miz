/**
 * Issue #938 — the console's knowledge routes, at the boundary a reviewer
 * cares about.
 *
 * The service is covered by unit tests (mocked SQL) and by
 * `integration/knowledge-hardening.integration.test.ts` (real PostgreSQL).
 * What this file asserts is the HTTP contract the console depends on:
 *
 *  - reading is admin-only, every write needs `knowledge.manage`, and a denied
 *    write never reaches the service;
 *  - the writer recorded on the row/audit is the signed-in admin;
 *  - list paging/`q` bounds are enforced before the query;
 *  - `expectedVersion` is validated and a stale one becomes 409, not a 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  requirePlatformCapability: vi.fn(),
  audit: vi.fn(async () => {}),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  requirePlatformCapability: mocks.requirePlatformCapability,
  withPlatformScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
  platformAudit: mocks.audit,
}));

// Keep the real parsers and `knowledgeError`; replace only the database work.
vi.mock("@/lib/knowledge-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/knowledge-service")>();
  return {
    ...actual,
    adminListKbArticles: mocks.list,
    adminCreateKbArticle: mocks.create,
    adminUpdateKbArticle: mocks.update,
    adminGetKbArticle: mocks.get,
    adminDeleteKbArticle: mocks.remove,
  };
});

import { GET, POST } from "./route";
import { DELETE, PUT } from "./[id]/route";
import { KnowledgeServiceError } from "@/lib/knowledge-service";

const ADMIN = { session: { padmin: "admin-1", role: "owner" } };
const DENIED = {
  session: null,
  error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
};
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://admin.example.test${url}`, init);
}

function jsonRequest(method: string, body: unknown) {
  return request("/api/platform/knowledge/articles", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id = ID) {
  return { params: Promise.resolve({ id }) };
}

type Handler = (req: NextRequest, context: unknown) => Promise<Response>;
type ReadHandler = (req: NextRequest) => Promise<Response>;

async function callGet(url: string) {
  const res = await (GET as unknown as ReadHandler)(request(url));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const VALID_ARTICLE = {
  slug: "pos-basics",
  title: "راهنمای صندوق",
  summary: "",
  bodyMd: "## شروع\nمتن",
  categoryId: null,
  sectionKeys: [],
  tagIds: [],
  videoUrl: "",
  coverImageUrl: "",
  status: "published",
  sortOrder: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue(ADMIN);
  mocks.requirePlatformCapability.mockResolvedValue(ADMIN);
  mocks.audit.mockResolvedValue(undefined);
});

describe("GET /api/platform/knowledge/articles", () => {
  it("passes filters and page/limit through and returns the paginated envelope", async () => {
    mocks.list.mockResolvedValue({
      articles: [],
      total: 231,
      page: 2,
      pageSize: 100,
      totalPages: 3,
    });
    const result = await callGet(
      "/api/platform/knowledge/articles?page=2&limit=100&status=published&q=%D8%B5%D9%86%D8%AF%D9%88%D9%82",
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ total: 231, page: 2, totalPages: 3 });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "صندوق", status: "published" }),
      { page: 2, limit: 100 },
    );
  });

  it("refuses an over-long query before it reaches SQL", async () => {
    const result = await callGet(`/api/platform/knowledge/articles?q=${"ا".repeat(201)}`);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("query_too_long");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("is admin-only for reads", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue(DENIED);
    const result = await callGet("/api/platform/knowledge/articles");
    expect(result.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("POST /api/platform/knowledge/articles", () => {
  it("does not create anything when the caller lacks knowledge.manage", async () => {
    mocks.requirePlatformCapability.mockResolvedValue(DENIED);
    const res = await (POST as unknown as ReadHandler)(jsonRequest("POST", VALID_ARTICLE));
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("records the signed-in admin as the author", async () => {
    mocks.create.mockResolvedValue(ID);
    const res = await (POST as unknown as ReadHandler)(jsonRequest("POST", VALID_ARTICLE));
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "pos-basics" }),
      "admin-1",
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        action: "knowledge_article.create",
        entityId: ID,
      }),
    );
  });

  it("rejects a non-http video and an invalid tag id as 400, without a write", async () => {
    for (const body of [
      { ...VALID_ARTICLE, videoUrl: "javascript:alert(1)" },
      { ...VALID_ARTICLE, tagIds: ["not-a-uuid"] },
    ]) {
      const res = await (POST as unknown as ReadHandler)(jsonRequest("POST", body));
      expect(res.status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("PUT /api/platform/knowledge/articles/[id]", () => {
  it("sends the expected version and returns the new one", async () => {
    mocks.update.mockResolvedValue(4);
    const res = await (PUT as unknown as Handler)(
      jsonRequest("PUT", { ...VALID_ARTICLE, expectedVersion: 3 }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: 4 });
    expect(mocks.update).toHaveBeenCalledWith(ID, expect.any(Object), "admin-1", 3);
  });

  it("rejects a malformed version before touching the service", async () => {
    const res = await (PUT as unknown as Handler)(
      jsonRequest("PUT", { ...VALID_ARTICLE, expectedVersion: 0 }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_version");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("maps a stale version to 409 version_conflict", async () => {
    mocks.update.mockRejectedValue(new KnowledgeServiceError("version_conflict"));
    const res = await (PUT as unknown as Handler)(
      jsonRequest("PUT", { ...VALID_ARTICLE, expectedVersion: 1 }),
      ctx(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("version_conflict");
  });

  it("refuses a malformed id as 404 rather than a cast error", async () => {
    const res = await (PUT as unknown as Handler)(jsonRequest("PUT", VALID_ARTICLE), ctx("nope"));
    expect(res.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires knowledge.manage to delete", async () => {
    mocks.requirePlatformCapability.mockResolvedValue(DENIED);
    const res = await (DELETE as unknown as Handler)(
      request("/api/platform/knowledge/articles/x", { method: "DELETE" }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
