// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdaptiveBottomNavSlots, MobileAppBottomNav } from "./app-bottom-nav";
import { MobileAppHeader } from "./app-header";
import { resolveAuthorizedQuickActions } from "./quick-create-sheet";
import { MobileFilterSheet } from "./mobile-filter-sheet";
import { MobileRecordList } from "./mobile-record-list";
import { MobileDetailHeader } from "./mobile-detail-header";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
});

describe("resolveAdaptiveBottomNavSlots", () => {
  it("adapts the sales slot to the business industry and user permissions", () => {
    const foodHrefs = new Set(["/dashboard", "/pos", "/crm", "/accounting/orders"]);
    expect(resolveAdaptiveBottomNavSlots({ industry: "food_service", allowedHrefs: foodHrefs })).toEqual({
      home: { key: "home", href: "/dashboard", label: "خانه" },
      sales: { key: "sales", href: "/pos", label: "فروش" },
      crm: { key: "crm", href: "/crm", label: "مشتریان" },
    });

    const clinicHrefs = new Set(["/dashboard", "/appointments", "/crm/customers"]);
    expect(resolveAdaptiveBottomNavSlots({ industry: "healthcare", allowedHrefs: clinicHrefs })).toEqual({
      home: { key: "home", href: "/dashboard", label: "خانه" },
      sales: { key: "sales", href: "/appointments", label: "نوبت‌ها" },
      crm: { key: "crm", href: "/crm/customers", label: "مشتریان" },
    });

    const aecHrefs = new Set(["/dashboard", "/projects", "/accounting/customers"]);
    expect(resolveAdaptiveBottomNavSlots({ industry: "aec", allowedHrefs: aecHrefs })).toEqual({
      home: { key: "home", href: "/dashboard", label: "خانه" },
      sales: { key: "sales", href: "/projects", label: "پروژه‌ها" },
      crm: { key: "crm", href: "/accounting/customers", label: "مشتریان" },
    });
  });
});

describe("resolveAuthorizedQuickActions", () => {
  it("includes only actions permitted by the user's allowedHrefs and enabled modules", () => {
    const fullHrefs = new Set([
      "/pos",
      "/crm/customers",
      "/accounting/receipts",
      "/accounting/expenses",
      "/accounting/products",
      "/crm/activities",
      "/workspace/tasks",
    ]);
    const allActions = resolveAuthorizedQuickActions({
      allowedHrefs: fullHrefs,
      crmEnabled: true,
      inventoryEnabled: true,
    });
    expect(allActions.map((a) => a.id)).toEqual([
      "new_order",
      "new_customer",
      "record_payment",
      "record_expense",
      "scan_barcode",
      "crm_activity",
      "new_task",
    ]);

    const cashierOnly = new Set(["/pos"]);
    const restricted = resolveAuthorizedQuickActions({
      allowedHrefs: cashierOnly,
      crmEnabled: false,
      inventoryEnabled: false,
    });
    expect(restricted.map((a) => a.id)).toEqual(["new_order"]);
  });
});

describe("MobileAppBottomNav, MobileRecordList, and MobileDetailHeader", () => {
  it("renders the 5-slot adaptive bottom bar and opens the quick-create sheet", () => {
    const onOpenMore = vi.fn();
    render(
      <MobileAppBottomNav
        industry="retail"
        allowedHrefs={new Set(["/dashboard", "/pos", "/crm"])}
        onOpenMore={onOpenMore}
      />,
    );

    expect(screen.getByText("خانه")).toBeTruthy();
    expect(screen.getByText("فروش")).toBeTruthy();
    expect(screen.getByText("مشتریان")).toBeTruthy();
    expect(screen.getByText("بیشتر")).toBeTruthy();

    fireEvent.click(screen.getByText("بیشتر"));
    expect(onOpenMore).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("ایجاد سریع"));
    expect(screen.getByText("ثبت سفارش / فروش جدید")).toBeTruthy();
  });

  it("renders scannable mobile record cards and empty state", () => {
    const onSelect = vi.fn();
    render(
      <MobileRecordList
        items={[
          {
            id: "rec-1",
            title: "فاکتور شماره ۱۰۴",
            subtitle: "رضا محمدی",
            amount: "۲,۵۰۰,۰۰۰ ریال",
            fields: [{ label: "وضعیت", value: "پرداخت‌شده" }],
            onSelect,
          },
        ]}
      />,
    );

    expect(screen.getByText("فاکتور شماره ۱۰۴")).toBeTruthy();
    expect(screen.getByText("۲,۵۰۰,۰۰۰ ریال")).toBeTruthy();
    fireEvent.click(screen.getByText("فاکتور شماره ۱۰۴"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders MobileDetailHeader with primary and overflow actions", () => {
    const onSecondary = vi.fn();
    render(
      <MobileDetailHeader
        title="مشتری: علی رضایی"
        subtitle="شماره: ۰۹۱۲۱۱۱۲۲۳۳"
        backHref="/crm/customers"
        secondaryActions={[{ key: "log_call", label: "ثبت تماس", onSelect: onSecondary }]}
      />,
    );

    expect(screen.getByText("مشتری: علی رضایی")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("عملیات بیشتر"));
    fireEvent.click(screen.getByText("ثبت تماس"));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it("renders MobileAppHeader with back button, search, and notification badge", () => {
    const onSearchClick = vi.fn();
    render(
      <MobileAppHeader
        title="سفارش‌ها"
        subtitle="فروش روزانه"
        backHref="/dashboard"
        onSearchClick={onSearchClick}
        unreadNotifications={5}
      />,
    );

    expect(screen.getByText("سفارش‌ها")).toBeTruthy();
    expect(screen.getByLabelText("بازگشت")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("جستجو"));
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it("renders MobileFilterSheet and triggers apply and reset handlers", () => {
    const onReset = vi.fn();
    render(
      <MobileFilterSheet activeCount={2} onReset={onReset}>
        <div>فیلتر وضعیت</div>
      </MobileFilterSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: /فیلتر و مرتب‌سازی/ }));
    expect(screen.getByText("فیلتر وضعیت")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "پاک کردن فیلترها" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
