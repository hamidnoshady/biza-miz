/**
 * Issue #1239 / ESH-90 — the wizard step's inline Knowledge Base extract.
 *
 * The page-level help is already covered by the catalogue tests; what matters
 * here is that the route only answers for a *known* step and the matching
 * `/setup` page, and that a missing article is `null` rather than an error (the
 * step keeps its local fallback).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as knowledgeService from "@/lib/knowledge-service";
import * as workspaceAccess from "@/lib/workspace-access";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
    requireMember: vi.fn(),
  };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});
vi.mock("@/lib/knowledge-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/knowledge-service")>();
  return {
    ...actual,
    kbGuideForSection: vi.fn(),
    kbGuideBodyForSection: vi.fn(),
    kbRelatedGuidesForArticle: vi.fn(),
  };
});
vi.mock("@/lib/workspace-access", () => ({ workspaceAccessFor: vi.fn() }));

const ARTICLE = "3. **انتخاب برنامه‌های کسب‌وکار** — قیمت‌ها منتشرشده‌اند. انتخاب پولی کم نمی‌کند.";

function request(query: string) {
  return new NextRequest(`http://localhost/api/knowledge?${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireMember).mockResolvedValue({
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(["settings.manage"]) },
    error: null,
  } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
  vi.mocked(workspaceAccess.workspaceAccessFor).mockResolvedValue({ available: true } as never);
  vi.mocked(knowledgeService.kbGuideForSection).mockResolvedValue(null);
  vi.mocked(knowledgeService.kbRelatedGuidesForArticle).mockResolvedValue([]);
  vi.mocked(knowledgeService.kbGuideBodyForSection).mockResolvedValue({
    slug: "setup-wizard",
    title: "راه‌اندازی",
    bodyMarkdown: ARTICLE,
  });
});

describe("/api/knowledge inline wizard help", () => {
  it("returns the excerpt for a known step of the matching /setup page", async () => {
    const response = await GET(request("page=page%3A%2Fsetup%2Fapps&step=apps"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.inlineHelp).toMatchObject({
      guide: { slug: "setup-wizard", title: "راه‌اندازی" },
    });
    expect(body.inlineHelp.lines).toEqual([
      "قیمت‌ها منتشرشده‌اند.",
      "انتخاب پولی کم نمی‌کند.",
    ]);
  });

  it("ignores a step that does not belong to the requested page", async () => {
    const response = await GET(request("page=page%3A%2Fsetup%2Ftax&step=apps"));
    expect((await response.json()).inlineHelp).toBeNull();
  });

  it("ignores an unknown step id instead of reading anything", async () => {
    const response = await GET(request("page=page%3A%2Fsetup%2Fapps&step=not-a-step"));
    expect((await response.json()).inlineHelp).toBeNull();
    expect(knowledgeService.kbGuideBodyForSection).not.toHaveBeenCalled();
  });

  it("answers null (not an error) when no article is published", async () => {
    vi.mocked(knowledgeService.kbGuideBodyForSection).mockResolvedValue(null);
    const response = await GET(request("page=page%3A%2Fsetup%2Fapps&step=apps"));
    expect(response.status).toBe(200);
    expect((await response.json()).inlineHelp).toBeNull();
  });
});
