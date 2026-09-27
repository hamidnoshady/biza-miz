// @vitest-environment jsdom

/**
 * The calendar popover renders `role="dialog"`, which promises the ARIA
 * date-picker-dialog contract: opening it moves focus onto a day, Tab stays
 * inside it while it's open, and closing it returns focus to the field that
 * opened it. None of that used to happen — the panel just appeared wherever
 * the DOM put it, with no attention paid to focus at all. These tests pin
 * the fix down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JalaliDatePicker } from "./jalali-date-picker";
import { todayJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

afterEach(() => {
  cleanup();
});

function openPicker(): { trigger: HTMLButtonElement } {
  const trigger = screen.getByRole("button", { name: "انتخاب تاریخ" }) as HTMLButtonElement;
  fireEvent.click(trigger);
  return { trigger };
}

describe("JalaliDatePicker — dialog focus behaviour", () => {
  it("moves focus onto today's cell when it opens with no value selected", () => {
    render(<JalaliDatePicker value="" onChange={() => {}} ariaLabel="انتخاب تاریخ" />);
    openPicker();

    const dialog = screen.getByRole("dialog", { name: "انتخاب تاریخ شمسی" });
    expect(dialog).not.toBe(null);
    expect(document.activeElement?.getAttribute("aria-current")).toBe("date");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("returns focus to the trigger when Escape closes the calendar", () => {
    render(<JalaliDatePicker value="" onChange={() => {}} ariaLabel="انتخاب تاریخ" />);
    const { trigger } = openPicker();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBe(null);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger after picking a day", () => {
    const onChange = vi.fn();
    render(<JalaliDatePicker value="" onChange={onChange} ariaLabel="انتخاب تاریخ" />);
    const { trigger } = openPicker();

    const today = todayJalali();
    const dayLabel = toPersianDigits(String(today.jd));
    const dayButton = screen.getByRole("button", { name: new RegExp(`^${dayLabel} `) });
    fireEvent.click(dayButton);

    expect(onChange).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBe(null);
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab inside the panel: forward from the last control wraps to the first", () => {
    render(<JalaliDatePicker value="" onChange={() => {}} ariaLabel="انتخاب تاریخ" clearable={false} />);
    openPicker();

    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll("button:not([disabled])");
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("does not strand focus at <body> when the top clear button unmounts itself", () => {
    const onChange = vi.fn();
    render(<JalaliDatePicker value="1403-01-01" onChange={onChange} ariaLabel="انتخاب تاریخ" />);

    const trigger = screen.getByRole("button", { name: "انتخاب تاریخ" });
    const clear = screen.getByRole("button", { name: "پاک کردن تاریخ" });
    clear.focus();
    fireEvent.click(clear);

    expect(onChange).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(trigger);
  });
});
