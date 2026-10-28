// @vitest-environment jsdom

/**
 * Issue #972 — the existing «آموزش» modal now offers a guided tour next to the
 * knowledge-base article, without a second button and without letting either
 * half break the other.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TourSummary } from "@/lib/tours";

const api = vi.fn();
const startTour = vi.fn();
let runtime: { startTour: typeof startTour } | null = { startTour };

vi.mock("next/navigation", () => ({ usePathname: () => "/accounting/products" }));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));
vi.mock("./ui", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("@/components/tours/tour-provider", () => ({ useTourRuntime: () => runtime }));

import { KnowledgeHelpButton } from "./knowledge-help";

function tour(overrides: Partial<TourSummary["progress"]> = {}): TourSummary {
  return {
    id: "accounting.products.list",
    version: 1,
    title: "آشنایی با فهرست محصولات",
    description: "توضیح تور",
    route: "/accounting/products",
    stepCount: 5,
    progress: {
      status: "not_started",
      seenCount: 0,
      totalSteps: 5,
      percent: 0,
      resumeStepId: null,
      outdated: false,
      lastActiveAt: null,
      completedAt: null,
      ...overrides,
    },
  };
}

const guide = { slug: "products", title: "راهنمای محصولات" };

/** Route each endpoint independently so one can fail while the other answers. */
function answer(options: {
  tours?: TourSummary[] | "fail";
  guide?: typeof guide | null;
  relatedGuides?: { slug: string; title: string; summary: string; sectionKeys: string[] }[];
}) {
  api.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/knowledge/tours")) {
      if (options.tours === "fail") throw new Error("offline");
      return { ok: true, status: 200, aborted: false, data: { tours: options.tours ?? [] } };
    }
    return {
      ok: true,
      status: 200,
      aborted: false,
      data: { entry: null, guide: options.guide ?? null, relatedGuides: options.relatedGuides ?? [] },
    };
  });
}

async function openModal() {
  fireEvent.click(screen.getByRole("button", { name: /آموزش/ }));
  await waitFor(() => expect(api).toHaveBeenCalled());
}

beforeEach(() => {
  api.mockReset();
  startTour.mockReset();
  runtime = { startTour };
});
afterEach(cleanup);

describe("KnowledgeHelpButton with a guided tour", () => {
  it("offers the tour and the article in one modal", async () => {
    answer({ tours: [tour()], guide });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("button", { name: "شروع تور" })).toBeTruthy();
    expect(screen.getByText("آشنایی با فهرست محصولات")).toBeTruthy();
    expect(screen.getByRole("link", { name: /راهنمای داخلی: راهنمای محصولات/ }).getAttribute("href")).toBe("/knowledge/a/products");
    // One button on the page, not two.
    expect(document.querySelectorAll('button[aria-label^="آموزش"]')).toHaveLength(1);
  });

  it("shows the current-page guide first, then independent links for the other Products pages", async () => {
    answer({
      guide,
      relatedGuides: [
        { slug: "products-new", title: "افزودن محصول", summary: "ثبت محصول و تنوع‌ها", sectionKeys: ["page:/accounting/products/new"] },
        { slug: "products-prices", title: "به‌روزرسانی قیمت‌ها", summary: "قیمت خرید و فروش", sectionKeys: ["page:/accounting/products/prices"] },
      ],
    });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    const primary = await screen.findByRole("link", { name: /راهنمای داخلی: راهنمای محصولات/ });
    expect(primary.getAttribute("href")).toBe("/knowledge/a/products");
    expect(screen.getByText("سایر راهنماهای این بخش")).toBeTruthy();
    const add = screen.getByRole("link", { name: /افزودن محصول/ });
    const prices = screen.getByRole("link", { name: /به‌روزرسانی قیمت‌ها/ });
    expect(add.getAttribute("href")).toBe("/knowledge/a/products-new");
    expect(prices.getAttribute("href")).toBe("/knowledge/a/products-prices");
    expect(screen.getByText("ثبت محصول و تنوع‌ها")).toBeTruthy();
    // Current-page guidance precedes the related list in the document.
    expect(primary.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('button[aria-label^="آموزش"]')).toHaveLength(1);
  });

  it("preserves the single-guide UI when no related articles are returned", async () => {
    answer({ guide, relatedGuides: [] });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("link", { name: /راهنمای داخلی: راهنمای محصولات/ })).toBeTruthy();
    expect(screen.queryByText("سایر راهنماهای این بخش")).toBeNull();
  });
  it("shows the article while the tour lookup is still pending", async () => {
    api.mockImplementation((url: string) =>
      url.startsWith("/api/knowledge/tours")
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, status: 200, aborted: false, data: { entry: null, guide } }),
    );
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("link", { name: /راهنمای داخلی: راهنمای محصولات/ })).toBeTruthy();
  });

  it("starts the tour from its first step and closes the modal", async () => {
    answer({ tours: [tour()], guide });
    startTour.mockResolvedValue(true);
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    fireEvent.click(await screen.findByRole("button", { name: "شروع تور" }));
    await waitFor(() => expect(startTour).toHaveBeenCalledTimes(1));
    expect(startTour.mock.calls[0][0]).toBe("accounting.products.list");
    expect(startTour.mock.calls[0][1]).toMatchObject({ fromStart: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers Continue with progress, and a deliberate restart that is not a reset", async () => {
    answer({ tours: [tour({ status: "in_progress", seenCount: 2, percent: 40, resumeStepId: "table" })], guide });
    startTour.mockResolvedValue(true);
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByText("۲ از ۵ مرحله دیده شد")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "پیشرفت تور" }).getAttribute("aria-valuenow")).toBe("40");
    fireEvent.click(screen.getByRole("button", { name: "از ابتدا" }));
    await waitFor(() => expect(startTour).toHaveBeenCalled());
    expect(startTour.mock.calls[0][1]).toMatchObject({ fromStart: true });
  });

  it("offers a review of a completed tour", async () => {
    answer({ tours: [tour({ status: "completed", seenCount: 5, percent: 100 })], guide });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("button", { name: "مرور دوباره" })).toBeTruthy();
    expect(screen.getByText("کامل شد")).toBeTruthy();
  });

  it("keeps the modal open and says so when the tour cannot start", async () => {
    answer({ tours: [tour()], guide });
    startTour.mockResolvedValue(false);
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    fireEvent.click(await screen.findByRole("button", { name: "شروع تور" }));
    expect((await screen.findByRole("alert")).textContent).toContain("شروع تور ممکن نشد");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("link", { name: /راهنمای داخلی/ })).toBeTruthy();
  });

  it("still shows the article when the tour lookup fails", async () => {
    answer({ tours: "fail", guide });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("link", { name: /راهنمای داخلی/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "شروع تور" })).toBeNull();
  });

  it("looks exactly as before on a page with no tour", async () => {
    answer({ tours: [], guide: null });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByText("هنوز صفحهٔ آموزشی برای این بخش ثبت نشده است.")).toBeTruthy();
    expect(screen.queryByText("تور تعاملی صفحه")).toBeNull();
  });

  it("shows only a compact note, with the way to the Knowledge Center, when a tour exists but no article does", async () => {
    answer({ tours: [tour()], guide: null });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("button", { name: "شروع تور" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "مرکز آموزش" }).getAttribute("href")).toBe("/knowledge");
  });

  it("offers no tour outside the workspace shell", async () => {
    runtime = null;
    answer({ tours: [tour()], guide });
    render(<KnowledgeHelpButton section="pos" />);
    await openModal();
    expect(await screen.findByRole("link", { name: /راهنمای داخلی/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "شروع تور" })).toBeNull();
  });
});
