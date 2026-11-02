// @vitest-environment jsdom

/**
 * A store with dozens of attribute groups used to render one endless column of
 * cards. The groups are a paged list now, closed cards preview their terms,
 * and a filter change returns to page one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(""),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/websites/wp/taxonomies",
  useSearchParams: () => nav.search,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/feature-lock", () => ({ useFeatureLocked: () => false }));
vi.mock("@/app/dashboard/ui", () => ({ api: vi.fn(), inputClass: "" }));

import { api } from "@/app/dashboard/ui";
import { TaxonomiesSection, type TermGroup } from "./taxonomies-section";

function attributeGroup(index: number): TermGroup {
  const terms = [1, 2].map((n) => ({
    remoteId: `${index}-${n}`,
    parentRemoteId: null,
    name: `رنگ ${index}-${n}`,
    slug: `color-${index}-${n}`,
    depth: 0,
    path: `رنگ ${index}-${n}`,
    remoteCount: n,
    mappedCount: n,
  }));
  return {
    taxonomy: `pa_attr-${index}`,
    label: `ویژگی ${index}`,
    isAttribute: true,
    termCount: terms.length,
    remoteCount: 3,
    mappedCount: 3,
    assignmentCount: 3,
    status: "synced",
    lastError: null,
    lastSyncedAt: null,
    restBase: null,
    terms,
  };
}

const groups = Array.from({ length: 30 }, (_, i) => attributeGroup(i + 1));

beforeEach(() => {
  nav.search = new URLSearchParams("");
  nav.replace.mockClear();
  vi.mocked(api).mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      groups,
      totals: { groups: 30, terms: 60, mappedProducts: 10, assignments: 90 },
      syncedAt: null,
      lastTaxonomySyncAt: null,
    },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaxonomiesSection — paged groups", () => {
  it("shows one page of groups, not all thirty, and pages through the rest", async () => {
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    expect(screen.queryByText("ویژگی 13")).toBeNull();
    expect(screen.getAllByText(/^ویژگی \d+$/)).toHaveLength(12);

    const pager = screen.getAllByRole("navigation", { name: "صفحه‌بندی گروه" })[0];
    fireEvent.click(within(pager).getByRole("button", { name: /بعدی/ }));
    await screen.findByText("ویژگی 13");
    expect(screen.queryByText("ویژگی 1")).toBeNull();
  });

  it("previews a closed group's terms and opens it on demand", async () => {
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    // Twelve groups on the page: all start closed, each with its term preview.
    const preview = screen.getByRole("list", { name: "نمونهٔ موردهای ویژگی 1" });
    expect(within(preview).getByText("رنگ 1-1")).toBeTruthy();
    const toggle = screen.getAllByRole("button", { name: /باز کردن/ }).find((b) => b.getAttribute("aria-controls") === "taxonomy-pa_attr-1");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns to the first page when a filter changes", async () => {
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    const pager = screen.getAllByRole("navigation", { name: "صفحه‌بندی گروه" })[0];
    fireEvent.click(within(pager).getByRole("button", { name: /بعدی/ }));
    await screen.findByText("ویژگی 13");

    fireEvent.change(screen.getByLabelText("جست‌وجو در دسته‌بندی‌ها و ویژگی‌ها"), { target: { value: "ویژگی 2" } });
    await waitFor(() => expect(screen.getByText("ویژگی 2")).toBeTruthy());
  });
});

describe("TaxonomiesSection — density and breadcrumbs (issue #1215, P2-4)", () => {
  it("keeps the chosen density in the URL, next to the store the picker owns", async () => {
    nav.search = new URLSearchParams("store=conn-1");
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");

    fireEvent.click(screen.getByRole("button", { name: "فشرده" }));
    // The store param is not lost: a view change must never switch store.
    expect(nav.replace).toHaveBeenCalledWith("/websites/wp/taxonomies?store=conn-1&view=compact", {
      scroll: false,
    });

    nav.replace.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "کامل" }));
    expect(nav.replace).toHaveBeenCalledWith("/websites/wp/taxonomies?store=conn-1", { scroll: false });
  });

  it("marks the density it is in, for a screen reader as well as the eye", async () => {
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    expect(screen.getByRole("button", { name: "کامل" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "فشرده" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("drops the slug column in the compact view and keeps it in the detailed one", async () => {
    const first = render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    const openDetailed = screen
      .getAllByRole("button", { name: /باز کردن/ })
      .find((button) => button.getAttribute("aria-controls") === "taxonomy-pa_attr-1");
    fireEvent.click(openDetailed as HTMLElement);
    // The slug is reachable text in the detailed rows.
    expect(await screen.findByText("color-1-1")).toBeTruthy();
    first.unmount();

    nav.search = new URLSearchParams("view=compact");
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    const openCompact = screen
      .getAllByRole("button", { name: /باز کردن/ })
      .find((button) => button.getAttribute("aria-controls") === "taxonomy-pa_attr-1");
    fireEvent.click(openCompact as HTMLElement);
    expect((await screen.findAllByText("فروشگاه ۱ • همگام ۱")).length).toBeGreaterThan(0);
    expect(screen.queryByText("color-1-1")).toBeNull();
  });

  it("shows a nested search hit's full path, which the flat result would otherwise hide", async () => {
    vi.mocked(api).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        groups: [
          {
            taxonomy: "product_cat",
            label: "دسته‌بندی محصول",
            isAttribute: false,
            termCount: 2,
            remoteCount: 4,
            mappedCount: 2,
            assignmentCount: 4,
            status: "synced",
            lastError: null,
            lastSyncedAt: null,
            restBase: null,
            terms: [
              { remoteId: "1", parentRemoteId: null, name: "پوشاک", slug: "clothing", depth: 0, path: "پوشاک", remoteCount: 2, mappedCount: 1 },
              {
                remoteId: "2",
                parentRemoteId: "1",
                name: "یقه‌دار",
                slug: "collared",
                depth: 2,
                path: "پوشاک › تی‌شرت › یقه‌دار",
                remoteCount: 2,
                mappedCount: 1,
              },
            ],
          },
        ],
        totals: { groups: 1, terms: 2, mappedProducts: 2, assignments: 4 },
        syncedAt: null,
        lastTaxonomySyncAt: null,
      },
    } as never);

    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("دسته‌بندی محصول");
    fireEvent.change(screen.getByLabelText("جست‌وجو در دسته‌بندی‌ها و ویژگی‌ها"), { target: { value: "یقه" } });
    // The hit keeps its place in the tree, in words.
    expect(await screen.findByText("پوشاک › تی‌شرت › یقه‌دار")).toBeTruthy();
  });
});

describe("TaxonomiesSection — «همگام‌سازی از وب‌سایت» in REST mode (#1206 PERF-05)", () => {
  function queued(via: "app" | "plugin", alreadyRunning = false) {
    vi.mocked(api).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return { ok: true, status: 200, data: { ok: true, queued: true, via, alreadyRunning, jobType: "taxonomy_sync" } } as never;
      }
      return {
        ok: true,
        status: 200,
        data: { groups, totals: { groups: 30, terms: 60, mappedProducts: 10, assignments: 90 }, syncedAt: null, lastTaxonomySyncAt: null },
      } as never;
    });
  }

  it("says this app reads the tree, not that the plugin will send it", async () => {
    queued("app");
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    fireEvent.click(screen.getAllByRole("button", { name: /همگام‌سازی از وب‌سایت/ })[0]);
    await screen.findByText(/خواندن درخت در صف قرار گرفت/);
    // The plugin sentence would be a lie about a REST store.
    expect(screen.queryByText(/افزونه/)).toBeNull();
  });

  it("distinguishes an already-running read from a newly queued one", async () => {
    queued("app", true);
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    fireEvent.click(screen.getAllByRole("button", { name: /همگام‌سازی از وب‌سایت/ })[0]);
    await screen.findByText(/خواندن درخت در جریان است/);
  });

  it("keeps the plugin sentence for a plugin connection", async () => {
    queued("plugin");
    render(<TaxonomiesSection connectionId="woo" />);
    await screen.findByText("ویژگی 1");
    fireEvent.click(screen.getAllByRole("button", { name: /همگام‌سازی از وب‌سایت/ })[0]);
    await screen.findByText(/فروشگاه در اجرای بعدی افزونه/);
  });
});
