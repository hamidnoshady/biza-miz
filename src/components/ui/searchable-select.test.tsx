// @vitest-environment jsdom

/**
 * The filter box drives a virtual "active option" with the arrow keys, but
 * DOM focus never leaves the input — that's the whole point of a Select2-
 * style combobox. Without `aria-activedescendant` a screen-reader user has
 * no way to know which option arrowing down actually lands on; they'd hear
 * nothing until they guessed right and hit Enter. These tests confirm the
 * input announces the active option as it changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchableSelect, type SelectOption } from "./searchable-select";

afterEach(() => {
  cleanup();
});

const OPTIONS: SelectOption[] = [
  { value: "gold", label: "طلا" },
  { value: "silver", label: "نقره" },
  { value: "platinum", label: "پلاتین" },
];

function open() {
  fireEvent.click(screen.getByRole("button", { name: "انتخاب کنید…" }));
  return screen.getByRole("combobox") as HTMLInputElement;
}

describe("SearchableSelect — active-option announcements", () => {
  it("points aria-activedescendant at the first option once opened", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={OPTIONS} />);
    const input = open();

    const firstOption = screen.getAllByRole("option")[0];
    expect(input.getAttribute("aria-activedescendant")).toBe(firstOption.id);
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("moves aria-activedescendant to the next option on ArrowDown", () => {
    render(<SearchableSelect value="" onChange={() => {}} options={OPTIONS} />);
    const input = open();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
  });

  it("selects the active option on Enter, matching what aria-activedescendant announced", () => {
    const onChange = vi.fn();
    render(<SearchableSelect value="" onChange={onChange} options={OPTIONS} />);
    const input = open();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("silver");
  });
});
