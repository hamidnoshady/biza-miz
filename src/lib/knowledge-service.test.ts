/**
 * Service-layer regression tests for issue #938.
 *
 * The database is mocked at `./db` boundary, which is exactly where the
 * transaction wrapper lives: these tests prove that article writes run inside
 * one `withoutTenantScopeTransaction`, that a tag failure surfaces instead of
 * being swallowed, that optimistic versions and category cycles are rejected
 * before a second write, and that member reads all carry the inactive-category
 * visibility predicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("./db", () => ({
  query: (...args: unknown[]) => db.query(...args),
  withoutTenantScopeTransaction: async (
    _reason: string,
    fn: () => Promise<unknown>,
  ) => db.tx(fn),
}));

import {
  adminCreateKbArticle,
  adminGetKbArticle,
  adminListKbArticles,
  adminUpdateKbArticle,
  adminUpdateKbCategory,
  KnowledgeServiceError,
  knowledgeError,
  parseArticleInput,
  searchKbArticles,
  getKbArticleBySlug,
  listKbCatalogue,
  kbRelatedGuidesForArticle,
} from "./knowledge-service";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

const ARTICLE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAG_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORY_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const SECTION_KEYS = new Set(["pos", "page:/accounting/pos"]);

function input(overrides: Record<string, unknown> = {}) {
  return {
    slug: "pos-basics",
    categoryId: null,
    sectionKeys: ["pos"],
    title: "راهنمای صندوق",
    summary: "خلاصه",
    bodyMd: "## شروع\nمتن",
    videoUrl: "",
    coverImageUrl: "",
    status: "published" as const,
    sortOrder: 0,
    tagIds: [] as string[],
    ...overrides,
  };
}

/** A handler that records every statement and answers by SQL shape. */
function handler(
  responses: (sql: string, params: unknown[]) => QueryResult | undefined,
): (sql: string, params: unknown[]) => Promise<QueryResult> {
  return async (sql, params = []) => responses(sql, params) ?? { rows: [], rowCount: 0 };
}

beforeEach(() => {
  db.query.mockReset();
  db.tx.mockReset();
  db.tx.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe("article writes are transactional and validated first (P1)", () => {
  it("creates the article and its tags inside one transaction", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        if (sql.includes("FROM knowledge_categories")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        if (sql.includes("FROM knowledge_tags")) {
          return { rows: [{ id: TAG_UUID }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO knowledge_articles")) {
          return { rows: [{ id: ARTICLE_UUID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    );

    const id = await adminCreateKbArticle(
      input({ categoryId: CATEGORY_UUID, tagIds: [TAG_UUID] }),
      "admin-1",
    );

    expect(id).toBe(ARTICLE_UUID);
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(calls.some((sql) => sql.includes("INSERT INTO knowledge_articles"))).toBe(true);
    expect(calls.some((sql) => sql.includes("DELETE FROM knowledge_article_tags"))).toBe(true);
    expect(calls.some((sql) => sql.includes("unnest($2::uuid[])"))).toBe(true);
    // The tag links are written once, as a set — not one query per tag.
    expect(calls.filter((sql) => sql.includes("INSERT INTO knowledge_article_tags"))).toHaveLength(1);
  });

  it("does not write the article when a tag id is unknown", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        if (sql.includes("FROM knowledge_tags")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
    );

    await expect(
      adminCreateKbArticle(input({ tagIds: [TAG_UUID] }), "admin-1"),
    ).rejects.toMatchObject({ code: "unknown_tag" });
    expect(calls.some((sql) => sql.includes("INSERT INTO knowledge_articles"))).toBe(false);
    expect(calls.some((sql) => sql.includes("DELETE FROM knowledge_article_tags"))).toBe(false);
  });

  it("propagates a tag-insert failure instead of reporting success", async () => {
    db.query.mockImplementation(
      handler((sql) => {
        if (sql.includes("FROM knowledge_tags")) return { rows: [{ id: TAG_UUID }], rowCount: 1 };
        if (sql.includes("INSERT INTO knowledge_articles")) {
          return { rows: [{ id: ARTICLE_UUID }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO knowledge_article_tags")) {
          throw Object.assign(new Error("boom"), { code: "23503" });
        }
        return { rows: [], rowCount: 0 };
      }),
    );

    await expect(
      adminCreateKbArticle(input({ tagIds: [TAG_UUID] }), "admin-1"),
    ).rejects.toBeTruthy();
    // The article insert ran inside the same tx wrapper as the failing tag
    // insert, so the real connection rolls it back.
    expect(db.tx).toHaveBeenCalledTimes(1);
  });

  it("returns 409 version_conflict and changes no tags when the version is stale", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        if (sql.includes("FROM knowledge_categories")) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE knowledge_articles")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT 1 FROM knowledge_articles")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    );

    await expect(adminUpdateKbArticle(ARTICLE_UUID, input(), "admin-1", 3)).rejects.toMatchObject({
      code: "version_conflict",
    });
    expect(calls.some((sql) => sql.includes("DELETE FROM knowledge_article_tags"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO knowledge_article_tags"))).toBe(false);
  });

  it("increments and returns the new version on a matching save", async () => {
    db.query.mockImplementation(
      handler((sql) => {
        if (sql.includes("UPDATE knowledge_articles")) {
          return { rows: [{ version: 4 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    );

    await expect(adminUpdateKbArticle(ARTICLE_UUID, input(), "admin-1", 3)).resolves.toBe(4);
  });
});

describe("category ancestry is rejected, not just self-parenting (P1)", () => {
  it("refuses moving A below its descendant C", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        if (sql.includes("FOR UPDATE")) {
          return { rows: [{ id: ARTICLE_UUID }, { id: CATEGORY_UUID }], rowCount: 2 };
        }
        if (sql.includes("WITH RECURSIVE chain")) {
          return { rows: [{ existed: true, cycle: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    );

    await expect(
      adminUpdateKbCategory(
        ARTICLE_UUID,
        {
          slug: "a",
          title: "الف",
          description: "",
          icon: "",
          tone: "",
          parentId: CATEGORY_UUID,
          sortOrder: 0,
          isActive: true,
        },
        "test-admin",
      ),
    ).rejects.toMatchObject({ code: "category_cycle" });
    expect(calls.some((sql) => sql.includes("UPDATE knowledge_categories"))).toBe(false);
  });

  it("rejects a malformed parent id before querying", async () => {
    await expect(
      adminUpdateKbCategory(
        ARTICLE_UUID,
        {
          slug: "a",
          title: "الف",
          description: "",
          icon: "",
          tone: "",
          parentId: "not-a-uuid",
          sortOrder: 0,
          isActive: true,
        },
        "test-admin",
      ),
    ).rejects.toMatchObject({ code: "parent_not_found" });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("member reads apply the inactive-category visibility policy (P1)", () => {
  it("uses the recursive active-category CTE in the catalogue", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    );
    await listKbCatalogue();
    expect(calls).toHaveLength(4);
    for (const sql of calls) {
      expect(sql).toContain("WITH RECURSIVE visible_categories");
      expect(sql).toContain("is_active = true");
    }
    expect(calls.filter((sql) => sql.includes("a.category_id IS NULL OR a.category_id IN"))).toHaveLength(3);
  });

  it("hides an article whose category branch is inactive on a direct slug", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      }),
    );
    await expect(getKbArticleBySlug("pos-basics")).resolves.toBeNull();
    expect(calls[0]).toContain("visible_categories");
    expect(calls[0]).toContain("a.category_id IS NULL OR a.category_id IN");
  });

  it("searches the normalized body and applies visibility", async () => {
    let params: unknown[] = [];
    db.query.mockImplementation(
      handler((sql, values) => {
        if (sql.includes("SELECT a.id")) params = values;
        return { rows: [], rowCount: 0 };
      }),
    );
    await searchKbArticles("جستجوي كالا", 20);
    expect(params[0]).toBe("جستجوی کالا");
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain("a.search_text LIKE");
    expect(sql).toContain("visible_categories");
    expect(sql).toContain("ESCAPE");
  });
});

describe("related published guides in a page-help modal", () => {
  it("returns only same-category published siblings in deterministic order", async () => {
    db.query.mockImplementation(
      handler((sql, params) => {
        expect(params).toEqual(["accounting-products-guide"]);
        expect(sql).toContain("WITH RECURSIVE visible_categories");
        expect(sql).toContain("chosen.category_id IN (SELECT id FROM visible_categories)");
        expect(sql).toContain("a.category_id = chosen.category_id");
        expect(sql).toContain("a.id <> chosen.id");
        expect(sql).toContain("a.status = 'published'");
        expect(sql).toContain("chosen.status = 'published'");
        expect(sql).toContain("a.category_id IS NULL OR a.category_id IN");
        expect(sql).toContain("ORDER BY a.sort_order, a.title, a.id");
        expect(sql).toContain("LIMIT 24");
        return {
          rows: [
            { slug: "accounting-products-new-guide", title: "افزودن محصول", summary: "راهنما", section_keys: ["page:/accounting/products/new"] },
            { slug: "accounting-products-prices-guide", title: "قیمت‌ها", summary: "", section_keys: ["page:/accounting/products/prices"] },
          ],
          rowCount: 2,
        };
      }),
    );
    const related = await kbRelatedGuidesForArticle("accounting-products-guide");
    expect(related.map((x) => x.slug)).toEqual(["accounting-products-new-guide", "accounting-products-prices-guide"]);
    expect(related[0].sectionKeys).toEqual(["page:/accounting/products/new"]);
    expect(related[0].summary).toBe("راهنما");
  });

  it("returns no siblings for an article without a visible category", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(kbRelatedGuidesForArticle("uncategorized")).resolves.toEqual([]);
  });
});
describe("admin pagination (P2)", () => {
  it("returns a bounded page and total instead of a silent LIMIT 200", async () => {
    const calls: string[] = [];
    db.query.mockImplementation(
      handler((sql, params) => {
        calls.push(sql);
        if (sql.includes("count(*)")) return { rows: [{ total: "231" }], rowCount: 1 };
        if (sql.includes("ORDER BY a.updated_at DESC, a.id DESC")) {
          expect(params[params.length - 2]).toBe(50);
          expect(params[params.length - 1]).toBe(50);
          return {
            rows: [
              {
                id: ARTICLE_UUID,
                slug: "pos-basics",
                category_id: null,
                section_keys: [],
                title: "راهنما",
                summary: "",
                body_md: "",
                video_url: "",
                cover_image_url: "",
                status: "published",
                sort_order: 0,
                version: 2,
                updated_at: "2026-01-01T00:00:00.000Z",
                tag_ids: [],
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    );

    const page = await adminListKbArticles({}, { page: 2, limit: 50 });
    expect(page).toMatchObject({ total: 231, page: 2, pageSize: 50, totalPages: 5 });
    expect(page.articles[0].version).toBe(2);
    expect(calls.some((sql) => sql.includes("LIMIT 200"))).toBe(false);
  });

  it("clamps limit and page to their documented bounds", async () => {
    let offset: unknown;
    let limit: unknown;
    db.query.mockImplementation(
      handler((sql, params) => {
        if (sql.includes("ORDER BY a.updated_at")) {
          limit = params[params.length - 2];
          offset = params[params.length - 1];
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ total: 0 }], rowCount: 0 };
      }),
    );
    await adminListKbArticles({}, { page: 999_999, limit: 99_999 });
    expect(limit).toBe(100);
    expect(offset).toBe(1_000_000);
  });

  it("rejects a non-uuid filter with an actionable 400 code", async () => {
    await expect(adminListKbArticles({ categoryId: "nope" })).rejects.toMatchObject({
      code: "invalid_category_id",
    });
  });
});

describe("article input validation (P2)", () => {
  it("accepts a page key and a supported video host", () => {
    const parsed = parseArticleInput(
      {
        ...input({
          categoryId: CATEGORY_UUID,
          tagIds: [TAG_UUID],
          videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }),
      },
      SECTION_KEYS,
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-uuid category id", () => {
    expect(parseArticleInput(input({ categoryId: "cat" }), SECTION_KEYS)).toMatchObject({
      ok: false,
      error: "invalid_category_id",
    });
  });

  it("rejects non-uuid tag ids and too many tags", () => {
    expect(parseArticleInput(input({ tagIds: ["tag"] }), SECTION_KEYS)).toMatchObject({
      ok: false,
      error: "invalid_tag_id",
    });
    const many = Array.from({ length: 21 }, (_, index) =>
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
    );
    expect(parseArticleInput(input({ tagIds: many }), SECTION_KEYS)).toMatchObject({
      ok: false,
      error: "too_many_tags",
    });
  });

  it("keeps a legacy http(s) page as an external link instead of making the article uneditable", () => {
    // KbVideo renders an unknown host as a new-tab card, never as a frame, so
    // an article written before the allowlist stays editable (title, body,
    // status …) without forcing the operator to delete its video URL first.
    const parsed = parseArticleInput(
      input({ videoUrl: "https://example.com/not-a-video" }),
      SECTION_KEYS,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.input.videoUrl).toBe("https://example.com/not-a-video");
  });

  it("rejects a non-http video URL and out-of-range ordering", () => {
    expect(
      parseArticleInput(input({ videoUrl: "javascript:alert(1)" }), SECTION_KEYS),
    ).toMatchObject({ ok: false, error: "invalid_video_url" });
    expect(parseArticleInput(input({ sortOrder: 1_000_000 }), SECTION_KEYS)).toMatchObject({
      ok: false,
      error: "invalid_sort_order",
    });
  });

  it("drops unknown section keys but keeps known page keys", () => {
    const parsed = parseArticleInput(
      input({ sectionKeys: ["pos", "page:/accounting/pos", "unknown"] }),
      SECTION_KEYS,
    );
    expect(parsed.ok && parsed.input.sectionKeys).toEqual(["pos", "page:/accounting/pos"]);
  });
});

describe("knowledgeError maps failures to actionable statuses", () => {
  const statusOf = (err: unknown) => knowledgeError(err).status;

  it("maps validation to 400, missing to 404, conflicts to 409", () => {
    expect(statusOf(new KnowledgeServiceError("invalid_tag_id"))).toBe(400);
    expect(statusOf(new KnowledgeServiceError("unknown_tag"))).toBe(400);
    expect(statusOf(new KnowledgeServiceError("not_found"))).toBe(404);
    expect(statusOf(new KnowledgeServiceError("parent_not_found"))).toBe(404);
    expect(statusOf(new KnowledgeServiceError("version_conflict"))).toBe(409);
    expect(statusOf(new KnowledgeServiceError("category_cycle"))).toBe(409);
  });

  it("maps Postgres constraint failures instead of returning a bare 500", () => {
    expect(statusOf({ code: "23505" })).toBe(409);
    expect(statusOf({ code: "23503" })).toBe(409);
    expect(statusOf({ code: "22P02" })).toBe(400);
    expect(statusOf({ code: "23514", message: "knowledge_category_cycle" })).toBe(409);
    expect(statusOf({ code: "23514", message: "check violation" })).toBe(400);
  });
});

describe("admin article read", () => {
  it("exposes the version the editor sends back", async () => {
    db.query.mockImplementation(
      handler(() => ({
        rows: [
          {
            id: ARTICLE_UUID,
            slug: "pos-basics",
            category_id: null,
            section_keys: [],
            title: "راهنما",
            summary: "",
            body_md: "",
            video_url: "",
            cover_image_url: "",
            status: "draft",
            sort_order: 0,
            version: 7,
            updated_at: "2026-01-01T00:00:00.000Z",
            tag_ids: [],
          },
        ],
        rowCount: 1,
      })),
    );
    const article = await adminGetKbArticle(ARTICLE_UUID);
    expect(article?.version).toBe(7);
  });
});
