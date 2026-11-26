// @vitest-environment jsdom

/**
 * Issue #1572 — the visible «تغییر کسب‌وکار» control.
 *
 * The card must stay out of the way when there is nothing to switch to: no
 * desktop bridge in a browser, and a single saved business on a desktop
 * install. When two businesses exist it is visible and its one click goes to
 * the shell's own `business.change()`, never to a route or a renderer-supplied
 * business id.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesktopBridge } from "@/lib/desktop-bridge";
import { DesktopBusinessSwitch } from "./desktop-business-switch";

function fakeBridge(multiBusiness: boolean) {
  return {
    current: vi.fn(async () => ({ status: null, multiBusiness })),
    change: vi.fn(async () => ({ ok: true as const })),
  };
}

function install(business: ReturnType<typeof fakeBridge>) {
  (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop = {
    isDesktop: true,
    business,
  } satisfies Partial<DesktopBridge>;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop;
});

describe("Desktop business switch", () => {
  it("renders nothing in a browser", () => {
    const { container } = render(<DesktopBusinessSwitch />);

    expect(container.innerHTML).toBe("");
  });

  it("stays hidden when the install holds only one business", async () => {
    const business = fakeBridge(false);
    install(business);

    const { container } = render(<DesktopBusinessSwitch />);

    await vi.waitFor(() => expect(business.current).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: /تغییر کسب‌وکار/ })).toBeNull();
  });

  it("shows the control with two or more businesses and hands the click to the shell", async () => {
    const business = fakeBridge(true);
    install(business);

    render(<DesktopBusinessSwitch />);

    const button = await screen.findByRole("button", { name: "تغییر کسب‌وکار" });
    fireEvent.click(button);

    expect(business.change).toHaveBeenCalledTimes(1);
  });

  it("reports a failed switch instead of pretending the app is restarting", async () => {
    const business = fakeBridge(true);
    business.change.mockRejectedValue(new Error("profile_registry_unreadable"));
    install(business);

    render(<DesktopBusinessSwitch />);

    fireEvent.click(await screen.findByRole("button", { name: "تغییر کسب‌وکار" }));

    expect(await screen.findByText(/تغییر کسب‌وکار انجام نشد/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "تغییر کسب‌وکار" })).toHaveProperty("disabled", false);
  });
});
