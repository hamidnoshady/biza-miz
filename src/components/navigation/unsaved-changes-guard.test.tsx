// @vitest-environment jsdom

/**
 * Issue #835 §7 — a screen with unsaved work must warn before an *in-app*
 * navigation, not only before a reload.
 *
 * The links under test are real `next/link` anchors inside Next's own router
 * context, because that is exactly what the sidebar and the workspace rail
 * render: the proof that matters is that Next's `<Link>` click handler never
 * runs, i.e. the router's `push` is not called, until the person says «leave».
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnsavedChangesDialog,
  guardedNavigate,
  internalNavigationTarget,
  useUnsavedChangesGuard,
} from "./unsaved-changes-guard";

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("next/navigation", () => ({ useRouter: () => router }));

function Harness({ dirty, onDiscard, onChip }: { dirty: boolean; onDiscard?: () => void; onChip?: () => void }) {
  const guard = useUnsavedChangesGuard(dirty, { onDiscard });
  return (
    <AppRouterContext.Provider value={router as never}>
      <nav>
        <Link href="/accounting/trial-balance">تراز آزمایشی</Link>
        <Link href="/accounting/expenses?view=all#top">هزینه‌ها</Link>
        <Link href="/accounting/payroll">همین صفحه</Link>
        <Link href="/accounting/payroll#details">پرش در همین صفحه</Link>
        <a href="https://example.com/docs">بیرونی</a>
        <a href="/accounting/vat" target="_blank" rel="noreferrer">تب جدید</a>
        <a href="/files/report.pdf" download>دانلود</a>
        <button type="button" onClick={() => guardedNavigate("/accounting/entries", () => onChip?.())}>
          چیپ بخش
        </button>
      </nav>
      <UnsavedChangesDialog guard={guard}>۲ تغییر ذخیره‌نشده دارید.</UnsavedChangesDialog>
    </AppRouterContext.Provider>
  );
}

/**
 * Did a click on a link get past the guard, into React and on up the tree?
 *
 * Next 15's `<Link>` navigates through an internal dispatcher, not through the
 * context router's `push`, so `router.push` cannot tell. What can: a click that
 * the guard let through keeps bubbling past React's root to `document`, where
 * this bubble-phase listener sees it. A click the guard stopped in the *capture*
 * phase — before React, so before Next's `<Link>` handler — never gets here.
 * (Only anchors are recorded: the dialog's own buttons bubble too.)
 */
const reachedBubblePhase = vi.fn<(label: string) => void>();
const onDocumentBubble = (event: Event) => {
  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a[href]") : null;
  if (anchor) reachedBubblePhase(anchor.textContent?.trim() ?? "");
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, "", "/accounting/payroll");
  document.addEventListener("click", onDocumentBubble, false);
});

afterEach(() => {
  document.removeEventListener("click", onDocumentBubble, false);
  cleanup();
});

describe("link navigation while there are unsaved changes", () => {
  it("lets a link through untouched when nothing is dirty", async () => {
    const user = userEvent.setup();
    render(<Harness dirty={false} />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    // The guard stayed out of it: the click went on to Next's <Link>…
    expect(reachedBubblePhase).toHaveBeenCalledWith("تراز آزمایشی");
    // …and no prompt appeared.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before leaving, and Next's <Link> does not navigate until the person decides", async () => {
    const user = userEvent.setup();
    render(<Harness dirty />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));

    // The click never got as far as React, so Next's <Link> handler never ran.
    expect(reachedBubblePhase).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("تغییرات ذخیره‌نشده");
    expect(dialog.textContent).toContain("۲ تغییر ذخیره‌نشده دارید.");
    expect(screen.getByRole("button", { name: "ماندن در صفحه" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ترک صفحه و حذف تغییرات" })).toBeTruthy();
  });

  it("stays on the page when asked to, and asks again next time", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    render(<Harness dirty onDiscard={onDiscard} />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    await user.click(await screen.findByRole("button", { name: "ماندن در صفحه" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reachedBubblePhase).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();

    await user.click(screen.getByRole("link", { name: "هزینه‌ها" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(reachedBubblePhase).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("treats Escape as «stay»", async () => {
    const user = userEvent.setup();
    render(<Harness dirty />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reachedBubblePhase).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("leaves — discarding first, then navigating to the exact destination — when asked to", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const onDiscard = vi.fn(() => calls.push("discard"));
    router.push.mockImplementation((href: string) => calls.push(`push ${href}`));
    render(<Harness dirty onDiscard={onDiscard} />);

    await user.click(screen.getByRole("link", { name: "هزینه‌ها" }));
    await user.click(await screen.findByRole("button", { name: "ترک صفحه و حذف تغییرات" }));

    // Path, query and hash all survive; the drafts go before the navigation.
    expect(calls).toEqual(["discard", "push /accounting/expenses?view=all#top"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["another origin", "بیرونی"],
    ["a new tab", "تب جدید"],
    ["a download", "دانلود"],
    ["a jump within this very page", "پرش در همین صفحه"],
  ])("does not interfere with %s", async (_name, label) => {
    render(<Harness dirty />);
    const link = screen.getByText(label);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not interfere with a link to the page you are already on", async () => {
    const user = userEvent.setup();
    render(<Harness dirty />);
    await user.click(screen.getByRole("link", { name: "همین صفحه" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // (Next handles it — it is the same page, so there is nothing to lose.)
    expect(reachedBubblePhase).toHaveBeenCalledWith("همین صفحه");
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["the middle button", { button: 1 }],
  ])("leaves a %s-click (a new tab or window) alone", (_name, init) => {
    render(<Harness dirty />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    screen.getByText("تراز آزمایشی").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("catches a click on an element nested inside the link", async () => {
    const user = userEvent.setup();
    function Nested() {
      const guard = useUnsavedChangesGuard(true);
      return (
        <AppRouterContext.Provider value={router as never}>
          <Link href="/accounting/trial-balance">
            <span data-testid="icon">★</span> <strong data-testid="label">تراز</strong>
          </Link>
          <UnsavedChangesDialog guard={guard}>x</UnsavedChangesDialog>
        </AppRouterContext.Provider>
      );
    }
    render(<Nested />);
    await user.click(screen.getByTestId("icon"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(reachedBubblePhase).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("stops guarding once the work is saved, and when the screen goes away", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Harness dirty />);
    rerender(<Harness dirty={false} />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    expect(reachedBubblePhase).toHaveBeenCalledWith("تراز آزمایشی");
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<Harness dirty />);
    unmount();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const anchor = document.body.appendChild(document.createElement("a"));
    anchor.href = "/somewhere-else";
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("programmatic navigation (section chips)", () => {
  it("proceeds at once when nothing is dirty", async () => {
    const user = userEvent.setup();
    const onChip = vi.fn();
    render(<Harness dirty={false} onChip={onChip} />);
    await user.click(screen.getByRole("button", { name: "چیپ بخش" }));
    expect(onChip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks first when dirty, and proceeds only on «leave»", async () => {
    const user = userEvent.setup();
    const onChip = vi.fn();
    const onDiscard = vi.fn();
    render(<Harness dirty onChip={onChip} onDiscard={onDiscard} />);
    await user.click(screen.getByRole("button", { name: "چیپ بخش" }));
    expect(onChip).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "ماندن در صفحه" }));
    expect(onChip).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "چیپ بخش" }));
    await user.click(await screen.findByRole("button", { name: "ترک صفحه و حذف تغییرات" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onChip).toHaveBeenCalledTimes(1);
  });

  it("proceeds at once after the guard is gone", () => {
    const { unmount } = render(<Harness dirty />);
    unmount();
    const proceed = vi.fn();
    guardedNavigate("/x", proceed);
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});

describe("reload and close", () => {
  it("asks the browser to confirm only while there are unsaved changes", () => {
    const { rerender } = render(<Harness dirty />);
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(dirtyEvent);
    });
    expect(dirtyEvent.defaultPrevented).toBe(true);

    rerender(<Harness dirty={false} />);
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    act(() => {
      window.dispatchEvent(cleanEvent);
    });
    expect(cleanEvent.defaultPrevented).toBe(false);
  });
});

describe("internalNavigationTarget", () => {
  function clickOn(html: string, init: MouseEventInit = {}): { event: MouseEvent; target: string | null } {
    document.body.innerHTML = html;
    const element = document.body.querySelector("[data-hit]") as HTMLElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: element });
    return { event, target: internalNavigationTarget(event) };
  }

  it("returns the path, query and hash of an in-app link", () => {
    expect(clickOn('<a data-hit href="/a/b?x=1#h">go</a>').target).toBe("/a/b?x=1#h");
    expect(clickOn('<a href="/a/b"><span data-hit>go</span></a>').target).toBe("/a/b");
  });

  it("returns null for everything that is not a page change", () => {
    window.history.pushState({}, "", "/accounting/payroll?tab=1");
    expect(clickOn('<span data-hit>not a link</span>').target).toBeNull();
    expect(clickOn('<a data-hit>no href</a>').target).toBeNull();
    expect(clickOn('<a data-hit href="mailto:a@b.c">mail</a>').target).toBeNull();
    expect(clickOn('<a data-hit href="javascript:void(0)">js</a>').target).toBeNull();
    expect(clickOn('<a data-hit href="#top">hash</a>').target).toBeNull();
    expect(clickOn('<a data-hit href="/accounting/payroll?tab=1#frag">same page</a>').target).toBeNull();
    // …but the same path with a different query IS a different page state.
    expect(clickOn('<a data-hit href="/accounting/payroll?tab=2">other tab</a>').target).toBe("/accounting/payroll?tab=2");
  });

  it("ignores a click somebody else already handled", () => {
    document.body.innerHTML = '<a data-hit href="/x">x</a>';
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: document.body.querySelector("[data-hit]") });
    event.preventDefault();
    expect(internalNavigationTarget(event)).toBeNull();
  });
});

describe("the prompt is a platform dialog, never the native confirm", () => {
  it("does not call window.confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const user = userEvent.setup();
    render(<Harness dirty />);
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirm).not.toHaveBeenCalled();
  });
});
