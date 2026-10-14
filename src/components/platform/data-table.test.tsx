/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PlatformDataTable, type Column } from "./data-table";

afterEach(() => cleanup());

interface Row {
  id: string;
  name: string;
  status: string;
}

const ROWS: Row[] = [
  { id: "1", name: "کافه نمونه", status: "فعال" },
  { id: "2", name: "فروشگاه دوم", status: "معلق" },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "کسب‌وکار", cell: (r) => r.name },
  { key: "status", header: "وضعیت", cell: (r) => r.status },
];

function mobileList(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".md\\:hidden");
  if (!el) throw new Error("mobile list not rendered");
  return el;
}

describe("PlatformDataTable — responsive title (audit F02)", () => {
  it("shows the first column as the mobile card title when no mobileTitle is supplied", () => {
    const { container } = render(
      <PlatformDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    const mobile = within(mobileList(container));
    expect(mobile.getByText("کافه نمونه")).toBeTruthy();
    expect(mobile.getByText("فروشگاه دوم")).toBeTruthy();
  });

  it("renders the identifying name exactly once per card, not twice", () => {
    const { container } = render(
      <PlatformDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />,
    );
    const cards = mobileList(container).querySelectorAll(":scope > div");
    expect(cards).toHaveLength(2);
    cards.forEach((card) => {
      expect(card.textContent?.match(/کافه نمونه|فروشگاه دوم/g)?.length ?? 0).toBeLessThanOrEqual(1);
    });
  });

  it("keeps an explicit mobileTitle as the title", () => {
    const { container } = render(
      <PlatformDataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        mobileTitle={(r) => <strong>عنوان {r.id}</strong>}
      />,
    );
    expect(within(mobileList(container)).getByText("عنوان 1")).toBeTruthy();
  });
});

describe("PlatformDataTable — keyboard details control (audit F20)", () => {
  it("gives every clickable row a named, focusable details button that opens the row", () => {
    const onRowClick = vi.fn();
    render(
      <PlatformDataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        detailsLabel="جزئیات کسب‌وکار"
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "جزئیات کسب‌وکار" });
    // One per row in the desktop table and one per mobile card.
    expect(buttons.length).toBe(ROWS.length * 2);
    fireEvent.click(buttons[0]);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("does not nest interactive roles: mobile cards are not role=button", () => {
    const { container } = render(
      <PlatformDataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={() => {}} />,
    );
    mobileList(container)
      .querySelectorAll(":scope > div")
      .forEach((card) => expect(card.getAttribute("role")).toBeNull());
  });
});

describe("PlatformDataTable — stale refresh (audit F12)", () => {
  it("keeps rows visible and announces a failed refresh with a retry action", () => {
    const onRetry = vi.fn();
    render(
      <PlatformDataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        error="network_error"
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/قدیمی/);
    expect(screen.getAllByText("کافه نمونه").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("replaces the list with an error state only when there is no data to keep", () => {
    render(
      <PlatformDataTable columns={COLUMNS} rows={null} rowKey={(r) => r.id} error="server_error" />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/بارگذاری ناموفق/);
    expect(screen.queryByText("تلاش دوباره")).toBeNull();
  });
});
