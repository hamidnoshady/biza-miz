// @vitest-environment jsdom

/**
 * A clickable row (#761 §23): a control inside it must not also open the row,
 * and the row itself — focusable — must open from the keyboard.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTableRow } from "./data-table";

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
