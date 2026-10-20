/**
 * Issue #938, P1/P2 — the database-level guarantees behind the knowledge
 * hardening, exercised against a real migrated database (CI only).
 *
 * The service unit tests prove the SQL is assembled correctly with a mocked
 * driver. These prove the parts a mock cannot: that a failed tag write rolls
 * the article row back, that the ancestor trigger and the service both reject
 * a cycle without eating the category, that an inactive branch hides its
 * articles from every member read, that optimistic versions collide as 409s,
 * and that pagination counts the whole table rather than a silent LIMIT.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/knowledge-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_knowledge_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/knowledge-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM knowledge_article_tags");
  await db.query("DELETE FROM knowledge_articles");
  await db.query("DELETE FROM knowledge_tags");
  await db.query("DELETE FROM knowledge_categories");
});

/** Compare two stored timestamps by instant (pg returns Date for timestamptz). */
function instant(value: string | Date): number {
  return new Date(value as unknown as string).getTime();
}

const CATEGORY = {
  description: "",
  icon: "",
  tone: "",
  parentId: null as string | null,
  sortOrder: 0,
  isActive: true,
};

async function category(slug: string, parentId: string | null = null, isActive = true) {
  return service.adminCreateKbCategory(
    { ...CATEGORY, slug, title: slug, parentId, isActive },
    "test-admin",
  );
}

async function tag(slug: string) {
  return service.adminCreateKbTag({ slug, label: slug, description: "" }, "test-admin");
}

function articleInput(overrides: Partial<Parameters<typeof service.adminCreateKbArticle>[0]> = {}) {
  return {
    slug: `guide-${randomUUID().slice(0, 8)}`,
    categoryId: null,
    sectionKeys: ["pos"],
    title: "راهنمای صندوق",
    summary: "خلاصه",
    bodyMd: "## شروع\nمتن راهنما",
    videoUrl: "",
    coverImageUrl: "",
    status: "published" as const,
    sortOrder: 0,
    tagIds: [],
    ...overrides,
  };
}

describe("article writes are atomic (P1)", () => {
  it("rolls the article insert back when the tag link insert fails", async () => {
    const tagId = await tag("printing");
    // A sentinel failure inside the second statement of the same transaction.
    await db.query(`
      CREATE OR REPLACE FUNCTION test_fail_tag_link() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'boom' USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER test_fail_tag_link_trigger
        BEFORE INSERT ON knowledge_article_tags
        FOR EACH ROW EXECUTE FUNCTION test_fail_tag_link();
    `);
    try {
      const slug = `atomic-${randomUUID().slice(0, 8)}`;
      await expect(
        service.adminCreateKbArticle(articleInput({ slug, tagIds: [tagId] }), "test-admin"),
      ).rejects.toBeTruthy();

      const { rows } = await db.query("SELECT id FROM knowledge_articles WHERE slug = $1", [slug]);
      expect(rows).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER IF EXISTS test_fail_tag_link_trigger ON knowledge_article_tags");
      await db.query("DROP FUNCTION IF EXISTS test_fail_tag_link()");
    }
  });

  it("does not change tags when a version conflict wins the race", async () => {
    const first = await tag("printing");
    const second = await tag("offline");
    const input = articleInput({ tagIds: [first] });
    const id = await service.adminCreateKbArticle(input, "test-admin");

    const loaded = await service.adminGetKbArticle(id);
    expect(loaded?.version).toBe(1);

    const updated = await service.adminUpdateKbArticle(
      id,
      { ...input, tagIds: [second] },
      "test-admin",
      loaded!.version,
    );
    expect(updated).toBe(2);

    await expect(
      service.adminUpdateKbArticle(id, { ...input, tagIds: [first] }, "test-admin", 1),
    ).rejects.toMatchObject({ code: "version_conflict" });

    const stored = await service.adminGetKbArticle(id);
    expect(stored?.version).toBe(2);
    expect(stored?.tagIds).toEqual([second]);
  });

  it("rejects unknown tag ids before changing the article", async () => {
    const input = articleInput();
    const id = await service.adminCreateKbArticle(input, "test-admin");
    const before = await service.adminGetKbArticle(id);

    await expect(
      service.adminUpdateKbArticle(
        id,
        { ...input, tagIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] },
        "test-admin",
        before!.version,
      ),
    ).rejects.toMatchObject({ code: "unknown_tag" });

    const after = await service.adminGetKbArticle(id);
    expect(after?.version).toBe(before!.version);
    // `pg` hands back `timestamptz` as a JS Date, so two reads of the same
    // instant are different objects. Compare the instant, not the identity.
    expect(instant(after!.updatedAt)).toBe(instant(before!.updatedAt));
  });
});

describe("category cycles are refused without losing data (P1)", () => {
  it("rejects a move below a descendant and leaves the tree intact", async () => {
    const a = await category("a");
    const b = await category("b", a);
    const c = await category("c", b);

    await expect(
      service.adminUpdateKbCategory(a, {
        ...CATEGORY,
        slug: "a",
        title: "a",
        parentId: c,
      }),
    ).rejects.toMatchObject({ code: "category_cycle" });

    const rows = await service.adminListKbCategories();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === a)?.parentId).toBeNull();
  });

  it("has a trigger that refuses a raw cycle too", async () => {
    const a = await category("a");
    const b = await category("b", a);
    await expect(
      db.query("UPDATE knowledge_categories SET parent_id = $2 WHERE id = $1", [a, b]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses to delete a category that still has children or articles", async () => {
    const parent = await category("parent");
    const child = await category("child", parent);
    await expect(service.adminDeleteKbCategory(parent)).rejects.toMatchObject({
      code: "category_has_children",
    });

    const own = await category("own");
    await service.adminCreateKbArticle(articleInput({ categoryId: own }), "test-admin");
    await expect(service.adminDeleteKbCategory(own)).rejects.toMatchObject({
      code: "category_has_articles",
    });
    expect((await service.adminListKbCategories()).map((row) => row.id)).toContain(child);
  });
});

describe("inactive categories hide their branch from members (P1)", () => {
  it("hides a grandchild article from the catalogue, the slug read and search", async () => {
    const root = await category("root");
    const middle = await category("middle", root);
    const leaf = await category("leaf", middle, false);
    const hiddenSlug = `hidden-${randomUUID().slice(0, 8)}`;
    await service.adminCreateKbArticle(
      articleInput({
        slug: hiddenSlug,
        categoryId: leaf,
        title: "پشتیبانی چاپگر",
        summary: "چاپگر گرم نمی‌شود",
        sectionKeys: ["pos"],
      }),
      "test-admin",
    );

    // Re-enabling the branch makes exactly the same row visible again.
    // The two ancestors stay visible — they are active themselves; the
    // inactive leaf is what hides its guides.
    const before = await service.listKbCatalogue();
    expect(before.categories.map((entry) => entry.slug).sort()).toEqual(["middle", "root"]);
    expect(before.articles).toHaveLength(0);
    expect(before.tags).toHaveLength(0);
    await expect(service.getKbArticleBySlug(hiddenSlug)).resolves.toBeNull();
    await expect(service.searchKbArticles("چاپگر")).resolves.toHaveLength(0);
    await expect(service.kbGuideForSection("pos")).resolves.toBeNull();
    await expect(service.listKbLatest()).resolves.toHaveLength(0);

    await service.adminUpdateKbCategory(leaf, {
      ...CATEGORY,
      slug: "leaf",
      title: "leaf",
      parentId: middle,
      isActive: true,
    });
    expect((await service.listKbCatalogue()).articles.map((a) => a.slug)).toEqual([hiddenSlug]);
    await expect(service.getKbArticleBySlug(hiddenSlug)).resolves.not.toBeNull();
    expect((await service.searchKbArticles("چاپگر")).map((hit) => hit.slug)).toEqual([hiddenSlug]);
  });

  it("still shows uncategorised published articles and hides drafts", async () => {
    const published = `uncat-${randomUUID().slice(0, 8)}`;
    const draft = `draft-${randomUUID().slice(0, 8)}`;
    await service.adminCreateKbArticle(articleInput({ slug: published }), "test-admin");
    await service.adminCreateKbArticle(
      articleInput({ slug: draft, status: "draft" }),
      "test-admin",
    );
    const catalogue = await service.listKbCatalogue();
    expect(catalogue.articles.map((a) => a.slug)).toEqual([published]);
    await expect(service.getKbArticleBySlug(draft)).resolves.toBeNull();
  });
});

describe("normalized search (P2)", () => {
  it("matches Arabic Yeh/Kaf, digits and ZWNJ variants", async () => {
    const slug = `search-${randomUUID().slice(0, 8)}`;
    await service.adminCreateKbArticle(
      articleInput({
        slug,
        title: "پشتیبانی سریع",
        summary: "شماره ۰۹۱۲",
        bodyMd: "## تماس\nبا پشتیبانی تماس بگیرید",
      }),
      "test-admin",
    );

    for (const query of ["پشتيباني", "پشتیبانی", "۰۹۱۲", "0912", "تماس"]) {
      const hits = await service.searchKbArticles(query);
      expect(hits.map((hit) => hit.slug), query).toEqual([slug]);
    }
  });

  it("finds a phrase that only exists in the body", async () => {
    const slug = `body-${randomUUID().slice(0, 8)}`;
    await service.adminCreateKbArticle(
      articleInput({
        slug,
        title: "گزارش فروش",
        summary: "خلاصهٔ کوتاه",
        bodyMd: "## جزئیات\nفیلتر «شعبهٔ مرکزی» را انتخاب کنید",
      }),
      "test-admin",
    );
    const hits = await service.searchKbArticles("شعبه مرکزی");
    expect(hits.map((hit) => hit.slug)).toEqual([slug]);
  });
});

describe("admin pagination (P2)", () => {
  it("pages through every article with a total count", async () => {
    const slugs: string[] = [];
    for (const order of [1, 2, 3]) {
      const slug = `page-${order}-${randomUUID().slice(0, 6)}`;
      slugs.push(slug);
      // Distinct updated_at so the deterministic (updated_at DESC, id DESC)
      // ordering is stable between two requests.
      await service.adminCreateKbArticle(
        articleInput({ slug, sortOrder: order }),
        "test-admin",
      );
      await db.query("UPDATE knowledge_articles SET updated_at = now() + ($2 || ' seconds')::interval WHERE slug = $1", [
        slug,
        String(order),
      ]);
    }

    const first = await service.adminListKbArticles({}, { page: 1, limit: 2 });
    const second = await service.adminListKbArticles({}, { page: 2, limit: 2 });
    expect(first.total).toBe(3);
    expect(first.totalPages).toBe(2);
    expect(first.articles).toHaveLength(2);
    expect(second.articles).toHaveLength(1);
    expect(new Set([...first.articles, ...second.articles].map((a) => a.slug))).toEqual(
      new Set(slugs),
    );
  });
});

describe("tenant boundary (P2)", () => {
  it("keeps the catalogue free of business_id columns and tenant rows", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_name LIKE 'knowledge%'
          AND column_name IN ('business_id', 'tenant_id')`,
    );
    expect(rows).toEqual([]);
    const { rows: policies } = await db.query<{ count: string }>(
      `SELECT count(*) FROM pg_policies
        WHERE tablename IN ('knowledge_categories', 'knowledge_tags',
                            'knowledge_articles', 'knowledge_article_tags')`,
    );
    expect(Number(policies[0].count)).toBe(0);
  });
});
