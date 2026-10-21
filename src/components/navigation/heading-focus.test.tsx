// @vitest-environment jsdom

/**
 * Issue #909 — "focus the destination heading after a committed navigation,
 * without stealing focus on a background refresh."
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadingFocusManager } from "./heading-focus";
import { PAGE_HEADING_ID } from "./page-heading-id";

let currentPathname = "/accounting/overview";
let currentSearch = "";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

/** Lets every queued `requestAnimationFrame` callback actually run. */
async function flushFrames(frames = 3) {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }
}

function Page({ title }: { title: string }) {
  return (
    <div>
      <h1 id={PAGE_HEADING_ID} tabIndex={-1}>
        {title}
      </h1>
      <button type="button">یک دکمهٔ معمولی</button>
    </div>
  );
}

function Harness({ title }: { title: string }) {
  return (
    <>
      <HeadingFocusManager />
      <Page title={title} />
    </>
  );
}

afterEach(() => {
  cleanup();
  currentPathname = "/accounting/overview";
  currentSearch = "";
});

describe("useFocusHeadingOnNavigate — heading focus after a committed navigation", () => {
  it("does not steal focus on the very first render (the browser's own landing)", async () => {
    render(<Harness title="نمای کلی" />);
    await flushFrames();
    expect(document.activeElement).not.toBe(document.getElementById(PAGE_HEADING_ID));
  });

  it("moves focus to the new page's heading once the route actually changes", async () => {
    const view = render(<Harness title="نمای کلی" />);
    await flushFrames();

    currentPathname = "/accounting/trial-balance";
    view.rerender(<Harness title="تراز آزمایشی" />);
    await flushFrames();

    expect(document.activeElement).toBe(document.getElementById(PAGE_HEADING_ID));
    expect(document.activeElement?.textContent).toBe("تراز آزمایشی");
  });

  it("moves focus on a query-only committed navigation too (e.g. Directory's ?view= tabs)", async () => {
    const view = render(<Harness title="فهرست مشتریان" />);
    await flushFrames();

    currentSearch = "view=suppliers";
    view.rerender(<Harness title="فهرست تأمین‌کنندگان" />);
    await flushFrames();

    expect(document.activeElement).toBe(document.getElementById(PAGE_HEADING_ID));
  });

  it("never steals focus for a background refresh that does not change the served route", async () => {
    const view = render(<Harness title="نمای کلی" />);
    await flushFrames();

    // Simulate a person focused on a control mid-page, then a same-scope
    // data refresh (a `useResourceState` retry, a `refreshKey` bump) that
    // re-renders the tree without the pathname/search ever changing.
    const button = document.querySelector("button");
    (button as HTMLElement).focus();
    expect(document.activeElement).toBe(button);

    view.rerender(<Harness title="نمای کلی" />);
    await flushFrames();

    expect(document.activeElement).toBe(button);
  });

  it("gives up gracefully when the route has no page-heading element to find", async () => {
    function NoHeadingPage() {
      return <p>بدون عنوان صفحه</p>;
    }
    function NoHeadingHarness() {
      return (
        <>
          <HeadingFocusManager />
          <NoHeadingPage />
        </>
      );
    }
    const view = render(<NoHeadingHarness />);
    await flushFrames();

    currentPathname = "/some/route-without-a-heading";
    expect(() => view.rerender(<NoHeadingHarness />)).not.toThrow();
    await flushFrames(35);
  });
});
