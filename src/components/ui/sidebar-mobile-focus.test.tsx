// @vitest-environment jsdom

/**
 * Issue #1553, part 2 — Escape on the phone drawer must return focus to the
 * hamburger that opened it.
 *
 * The drawer is a Radix `Dialog`, but it is opened by an ordinary button
 * calling `toggleSidebar`, not by a `DialogTrigger`. Radix can therefore only
 * restore focus to `body` when the dialog closes; this pins the explicit
 * hand-back for the Escape path.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // SidebarProvider reads the phone breakpoint on mount; "phone" here.
  window.matchMedia = ((query: string) => ({
    matches: query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  return (
    <SidebarProvider>
      <header>
        <SidebarTrigger />
      </header>
      <Sidebar>
        <SidebarContent>
          <a href="/dashboard/reports">گزارش‌ها</a>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}

describe("the phone drawer's Escape key", () => {
  it("returns focus to the hamburger that opened it", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "باز کردن منو" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    // The drawer is open and has taken focus.
    await screen.findByText("منوی داشبورد");
    await waitFor(() => expect(document.activeElement).not.toBe(trigger));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("منوی داشبورد")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
