import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CircleIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";
import {
  AppSectionNav,
  AppSectionNavSkeleton,
  BACK_TO_WORKSPACE_HREF,
  BACK_TO_WORKSPACE_LABEL,
  type AppSectionNavItem,
} from "./app-section-nav";

type Section = "overview" | "customers" | "orders";

const ITEMS: readonly AppSectionNavItem<Section>[] = [
  { key: "overview", label: "نمای کلی", description: "وضعیت برنامه", icon: CircleIcon },
  { key: "customers", label: "مشتریان", description: "فهرست مشتریان", icon: CircleIcon },
  { key: "orders", label: "سفارش‌ها", description: "پیگیری سفارش‌ها", icon: CircleIcon },
];

function renderNav({
  active = "customers",
  groups,
  open = true,
}: {
  active?: Section;
  groups?: readonly { label: string; keys: readonly Section[] }[];
  open?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      SidebarProvider,
      { open },
      createElement(
        Sidebar,
        null,
        createElement(AppSectionNav<Section>, {
          ariaLabel: "بخش‌های آزمایشی",
          title: "برنامهٔ آزمایشی",
          description: "توضیح برنامه",
          items: ITEMS,
          groups,
          hrefFor: (key) => `/test/${key}`,
          isActive: (key) => key === active,
          onNavigate: () => undefined,
        }),
      ),
    ),
  );
}

describe("AppSectionNav", () => {
  it("renders canonical links, an announced nav landmark and exactly one active page", () => {
    const markup = renderNav();

    expect(markup).toContain('aria-label="بخش‌های آزمایشی"');
    expect(markup).toContain("برنامهٔ آزمایشی");
    expect(markup).toContain("توضیح برنامه");
    expect(markup).toContain(`href="${BACK_TO_WORKSPACE_HREF}"`);
    expect(markup).toContain(BACK_TO_WORKSPACE_LABEL);
    for (const item of ITEMS) expect(markup).toContain(`href="/test/${item.key}"`);
    expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/test\/customers"/);
    expect((markup.match(/aria-current="page"/g) ?? [])).toHaveLength(1);
  });

  it("honours app-owned group order and cannot resurrect an item filtered out by the caller", () => {
    const markup = renderNav({
      groups: [
        { label: "مدیریت مشتری", keys: ["customers"] },
        // Website's connection-state gate has the same shape: absent keys must
        // stay absent even when a group still exists in the static IA.
        { label: "اتصال نشده", keys: [] },
        { label: "عملیات", keys: ["orders", "overview"] },
      ],
    });

    expect(markup).toContain("مدیریت مشتری");
    expect(markup).toContain("عملیات");
    expect(markup).not.toContain("اتصال نشده");
    expect(markup.indexOf("مدیریت مشتری")).toBeLessThan(markup.indexOf("عملیات"));
    expect(markup.indexOf("سفارش‌ها")).toBeLessThan(markup.indexOf("نمای کلی"));
  });

  it("keeps the collapsed-rail affordances and RTL back arrow structural rather than hiding navigation", () => {
    const markup = renderNav({ open: false });

    expect(markup).toContain('data-state="collapsed"');
    // Labels are visually hidden (sr-only) at the rail, not display:none, so the
    // collapsed links keep their accessible names.
    expect(markup).toContain("group-data-[state=collapsed]/sidebar:sr-only");
    expect(markup).toContain("rtl:rotate-180");
    // The links remain in the DOM (and keep their accessible labels/tooltips)
    // when the rail becomes an icon rail on a narrow workspace.
    for (const item of ITEMS) expect(markup).toContain(`href="/test/${item.key}"`);
  });

  it("uses an announced busy skeleton while a connection-gated menu is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        { open: true },
        createElement(
          Sidebar,
          null,
          createElement(AppSectionNavSkeleton, {
            ariaLabel: "بخش‌های مدیریت وب‌سایت",
            title: "مدیریت وب‌سایت",
            description: "وضعیت اتصال مدیرها",
          }),
        ),
      ),
    );

    expect(markup).toContain('aria-label="بخش‌های مدیریت وب‌سایت"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("مدیریت وب‌سایت");
  });
});
