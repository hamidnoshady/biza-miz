// @vitest-environment jsdom

/**
 * A clickable row (#761 §23): a control inside it must not also open the row,
 * and the row itself — focusable — must open from the keyboard.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DataCardTable,
  type DataCardTableColumn,
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "./data-table";

afterEach(cleanup);

function renderRow() {
  const open = vi.fn();
  const action = vi.fn();
  render(
    <table>
      <tbody>
        <DataTableRow onClick={open} data-testid="row">
          <td>ردیف</td>
          <td>
            <button type="button" onClick={action}>
              <span>اقدام</span>
            </button>
          </td>
        </DataTableRow>
      </tbody>
    </table>,
  );
  return { open, action, row: screen.getByTestId("row") };
}

describe("DataTableRow", () => {
  it("opens on a click on the row, not on a control inside it", () => {
    const { open, action, row } = renderRow();
    fireEvent.click(screen.getByText("ردیف"));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("اقدام"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(row.tabIndex).toBe(0);
  });

  it("lets a link inside the row do its own navigation, without also opening the row", () => {
    const open = vi.fn();
    render(
      <table>
        <tbody>
          <DataTableRow onClick={open}>
            <td>
              <a href="#run-7">دورهٔ ۷</a>
            </td>
          </DataTableRow>
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByRole("link", { name: "دورهٔ ۷" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("opens from Enter and Space on the row, never from a key on an inner control", () => {
    const { open, row } = renderRow();
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(open).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(2);
  });
});

/**
 * `DataCardTable` — one column declaration drives both the desktop `<table>`
 * and the phone `<ul>` of cards (issue #884 acceptance criterion #10). Both
 * are always in the DOM (the `hidden sm:block` / `sm:hidden` split is CSS,
 * invisible to jsdom), so a single render can assert on both halves at once.
 */
describe("DataCardTable", () => {
  interface Row {
    id: string;
    name: string;
    city: string;
    balance: string;
  }

  const rows: Row[] = [
    { id: "1", name: "علی رضایی", city: "تهران", balance: "۱۲۰٬۰۰۰" },
    { id: "2", name: "سارا احمدی", city: "اصفهان", balance: "۸۰٬۰۰۰" },
  ];

  const columns: DataCardTableColumn<Row>[] = [
    { key: "name", header: "نام", cell: (row) => row.name },
    { key: "city", header: "شهر", cell: (row) => row.city },
    { key: "balance", header: "مانده", cell: (row) => row.balance, align: "end", numeric: true },
    // Only makes sense beside the others on a wide grid — never a card field.
    { key: "id", header: "شناسه", cell: (row) => row.id, desktopOnly: true },
  ];

  it("renders the same rows as a table and as a list of cards from one column declaration", () => {
    render(<DataCardTable caption="فهرست اشخاص" columns={columns} rows={rows} />);

    // Desktop table: every column, including the desktop-only one.
    const table = screen.getByRole("table", { name: "فهرست اشخاص" });
    expect(table.textContent).toContain("شناسه");
    expect(screen.getAllByText("علی رضایی")).toHaveLength(2); // once in the table, once as the card title

    // Phone cards: the first column becomes the card's heading, the
    // desktop-only column never appears, and the rest are label/value pairs.
    const cardsList = document.querySelector("ul.sm\\:hidden");
    expect(cardsList).toBeTruthy();
    expect(cardsList?.textContent).not.toContain("شناسه");
    expect(cardsList?.textContent).toContain("سارا احمدی");
    expect(cardsList?.textContent).toContain("اصفهان");
  });

  it("uses an explicit cardTitle instead of repeating the first column", () => {
    render(
      <DataCardTable
        caption="فهرست اشخاص"
        columns={columns}
        rows={rows}
        cardTitle={(row) => `مشتری ${row.name}`}
      />,
    );
    const cardsList = document.querySelector("ul.sm\\:hidden");
    expect(cardsList?.textContent).toContain("مشتری علی رضایی");
    // The first column's own cell is not duplicated as a body field under it.
    const firstCard = cardsList?.querySelector("li");
    expect(firstCard?.querySelectorAll("dt")).toHaveLength(2); // city + balance, not name again
  });

  it("shows the empty state in both halves when there are no rows", async () => {
    render(<DataCardTable caption="فهرست اشخاص" columns={columns} rows={[]} empty="موردی یافت نشد." />);
    const matches = await screen.findAllByText("موردی یافت نشد.");
    expect(matches).toHaveLength(2); // the table's empty row and the cards' empty item
  });

  it("renders a footer as a totals row on the table and a summary card on the phone", () => {
    render(
      <DataCardTable
        caption="فهرست اشخاص"
        columns={columns}
        rows={rows}
        footer={[
          { key: "name", content: "جمع" },
          { key: "balance", content: "۲۰۰٬۰۰۰", numeric: true, label: "مانده" },
        ]}
      />,
    );
    const table = screen.getByRole("table", { name: "فهرست اشخاص" });
    expect(table.querySelector("tfoot")?.textContent).toContain("۲۰۰٬۰۰۰");
    const cardsList = document.querySelector("ul.sm\\:hidden");
    expect(cardsList?.textContent).toContain("جمع");
    expect(cardsList?.textContent).toContain("۲۰۰٬۰۰۰");
  });
});

describe("DataTable automatic mobile data-label injection", () => {
  it("extracts column headers from DataTableHead and stamps data-label onto each Td cell for mobile card rendering", () => {
    render(
      <DataTable caption="لیست هزینه‌ها">
        <DataTableHead>
          <Th>عنوان</Th>
          <Th numeric>مبلغ</Th>
        </DataTableHead>
        <DataTableBody>
          <DataTableRow>
            <Td>اجاره</Td>
            <Td numeric>۵٬۰۰۰٬۰۰۰</Td>
          </DataTableRow>
        </DataTableBody>
      </DataTable>,
    );

    const table = screen.getByRole("table", { name: "لیست هزینه‌ها" });
    expect(table.getAttribute("data-mobile-cards")).toBe("true");
    const cells = table.querySelectorAll("tbody td");
    expect(cells[0]?.getAttribute("data-label")).toBe("عنوان");
    expect(cells[1]?.getAttribute("data-label")).toBe("مبلغ");
  });
});
