// @vitest-environment jsdom
/**
 * Issue #938 — a heading deep link must survive the async article fetch.
 *
 * The browser tries to scroll to `#heading` before the body exists, so the
 * article view resolves the fragment against `kbHeadings` after render and
 * scrolls with the sticky-header offset. This test pins the wiring: nothing is
 * scrolled while loading, the requested id is looked up once the body is
 * mounted, and a fragment that matches no heading scrolls nowhere (rather than
 * jumping to the top of the document or the wrong section).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/knowledge/a/pos-basics",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { KbArticleView } from "./kb-article";
import type { KbArticleDetail, KbCataloguePayload } from "@/lib/knowledge";

const CATALOGUE: KbCataloguePayload = { categories: [], articles: [], tags: [] };

const ARTICLE: KbArticleDetail = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "pos-basics",
  title: "راهنمای صندوق",
  summary: "خلاصه",
  categoryId: null,
  sectionKeys: ["pos"],
  tags: [],
  hasVideo: false,
  hasCover: false,
  sortOrder: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  bodyMd: "## نصب و راه‌اندازی\nمتن\n\n## تسویهٔ چندگانه\nمتن دوم",
  videoUrl: "",
  videoKind: null,
  coverImageUrl: "",
  publishedAt: "2026-01-01T00:00:00.000Z",
  related: [],
};

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.location.hash = "";
  scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  // jsdom does not implement layout; the offset maths is covered by the pure
  // tests. Here we only care which element was asked for.
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/knowledge/catalogue")) return Promise.resolve(respond(CATALOGUE));
    if (url.includes("/api/knowledge/articles/")) return Promise.resolve(respond({ article: ARTICLE }));
    return Promise.resolve(respond({ error: "not_found" }));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("heading deep links after an async load (P2)", () => {
  it("scrolls to the heading named by the fragment once the body renders", async () => {
    window.location.hash = `#${encodeURIComponent("تسویهٔ چندگانه")}`;
    const getById = vi.spyOn(document, "getElementById");

    render(<KbArticleView slug="pos-basics" />);
    // While loading there is no body to scroll to.
    expect(scrollTo).not.toHaveBeenCalled();

    await screen.findByText("متن دوم");
    await waitFor(() => expect(getById).toHaveBeenCalledWith("تسویه-چندگانه"));
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    getById.mockRestore();
  });

  it("does not scroll to a heading that does not exist", async () => {
    window.location.hash = "#%D8%A8%D8%AE%D8%B4-%D9%86%D8%A7%D9%85%D9%88%D8%AC%D9%88%D8%AF";
    const getById = vi.spyOn(document, "getElementById");

    render(<KbArticleView slug="pos-basics" />);
    await screen.findByText("متن دوم");
    // Give the two rAFs a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalledWith("بخش-ناموجود");
    getById.mockRestore();
  });
});
