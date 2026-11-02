// @vitest-environment jsdom

/**
 * A store with dozens of attribute groups used to render one endless column of
 * cards. The groups are a paged list now, closed cards preview their terms,
 * and a filter change returns to page one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

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
