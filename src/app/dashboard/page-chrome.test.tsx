// @vitest-environment jsdom

/**
 * `TabBar`/`TabPanel` back every section switcher in the dashboard,
 * including the retail invoice screen's «صدور فاکتور» / «مدیریت فاکتورها»
 * strip. It used to render as a `<nav>` of `aria-pressed` toggle buttons —
 * visually a tab strip, but announced to a screen reader as a navigation
 * landmark of plain buttons, with no roving tabindex and no arrow-key
 * support. These tests hold the real `role="tablist"` contract in place.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabBar, TabPanel } from "./page-chrome";

afterEach(() => {
  cleanup();
});

function Demo({ onChange }: { onChange?: (key: "a" | "b" | "c") => void }) {
  const [active, setActive] = useState<"a" | "b" | "c">("a");
  return (
    <>
      <TabBar
        idPrefix="demo"
        label="بخش‌ها"
        tabs={[
          { key: "a", label: "الف" },
          { key: "b", label: "ب" },
          { key: "c", label: "ج" },
        ]}
        active={active}
        onChange={(key) => {
          setActive(key);
          onChange?.(key);
        }}
      />
      <TabPanel idPrefix="demo" active={active}>
        {active === "a" ? "محتوای الف" : active === "b" ? "محتوای ب" : "محتوای ج"}
      </TabPanel>
    </>
  );
}

describe("TabBar / TabPanel", () => {
  it("renders a real tablist: one tab selected, the rest unselected and out of the tab order", () => {
    render(<Demo />);

    const tablist = screen.getByRole("tablist", { name: "بخش‌ها" });
    expect(tablist).not.toBe(null);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].tabIndex).toBe(-1);
    expect(tabs[2].tabIndex).toBe(-1);
  });

  it("labels the panel as role=tabpanel, wired to the active tab via aria-labelledby", () => {
    render(<Demo />);
    const panel = screen.getByRole("tabpanel");
    const activeTab = screen.getAllByRole("tab")[0];
    expect(panel.getAttribute("aria-labelledby")).toBe(activeTab.id);
    expect(panel.tabIndex).toBe(0);
    expect(panel.textContent).toBe("محتوای الف");
  });

  it("moves selection and focus to the next tab on ArrowLeft (RTL forward) and updates the panel", () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });

    expect(onChange).toHaveBeenCalledWith("b");
    const updatedTabs = screen.getAllByRole("tab");
    expect(updatedTabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(updatedTabs[1]);
    expect(screen.getByRole("tabpanel").textContent).toBe("محتوای ب");
  });

  it("wraps from the last tab to the first on ArrowLeft, and jumps with Home/End", () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    let tabs = screen.getAllByRole("tab");
    tabs[2].focus();

    fireEvent.keyDown(tabs[2], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("a");

    tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");

    tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });
});
