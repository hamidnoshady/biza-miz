import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

/** A sidebar with one menu entry, rendered at the given desktop width. */
function menu(open: boolean, label = "داشبورد") {
  return createElement(
    SidebarProvider,
    { open },
    createElement(
      Sidebar,
      null,
      createElement(
        SidebarContent,
        null,
        createElement(
          SidebarMenu,
          null,
          createElement(
            SidebarMenuItem,
            null,
            createElement(SidebarMenuButton, { tooltip: label }, label),
          ),
        ),
      ),
    ),
  );
}

describe("SidebarProvider", () => {
  test("renders a collapsed menu button with a tooltip without requiring callers to add a tooltip provider", () => {
    expect(() => renderToStaticMarkup(menu(false))).not.toThrow();
  });

  test("the desktop rail reports its expanded/collapsed state, which every label hides against", () => {
    // `group-data-[state=collapsed]/sidebar:sr-only` is how a menu hides its
    // labels at 4rem while keeping them as accessible names. If the aside ever stopped publishing the state, every
    // label in every app menu would spill out of the rail at once.
    expect(renderToStaticMarkup(menu(false))).toContain('data-state="collapsed"');
    expect(renderToStaticMarkup(menu(true))).toContain('data-state="expanded"');
  });

  test("a collapsed row centres its icon instead of keeping the expanded row's padding", () => {
    const markup = renderToStaticMarkup(menu(false));
    expect(markup).toContain("group-data-[state=collapsed]/sidebar:justify-center");
  });
});

describe("SidebarTrigger", () => {
  test("says what it will do and what it controls, in both directions", () => {
    const collapsed = renderToStaticMarkup(
      createElement(SidebarProvider, { open: false }, createElement(SidebarTrigger, null)),
    );
    expect(collapsed).toContain("باز کردن نوار کناری");
    expect(collapsed).toContain('aria-expanded="false"');
    // Points at the element it opens, so a screen reader can follow it there.
    expect(collapsed).toContain('aria-controls="dashboard-sidebar"');

    const expanded = renderToStaticMarkup(
      createElement(SidebarProvider, { open: true }, createElement(SidebarTrigger, null)),
    );
    expect(expanded).toContain("جمع کردن نوار کناری");
    expect(expanded).toContain('aria-expanded="true"');
  });
});

describe("SidebarFooter", () => {
  test("scrolls within its own half rather than squeezing the menu above it", () => {
    // A phone in landscape, or a short POS panel, used to have the footer's
    // stack of controls push the nav down to a couple of visible rows.
    const markup = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        { open: true },
        createElement(Sidebar, null, createElement(SidebarFooter, null, "خروج")),
      ),
    );
    expect(markup).toContain("max-h-[50%]");
    expect(markup).toContain("overflow-y-auto");
  });
});
