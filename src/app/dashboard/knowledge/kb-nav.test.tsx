// @vitest-environment jsdom
/**
 * Client behaviour for issue #938 that cannot be proven by a pure function:
 *
 *  - a slow earlier search response must not replace a newer query's hits;
 *  - a failed search must show a retry instead of an endless skeleton;
 *  - the phone drawer traps focus, closes on Escape and returns focus;
 *  - `?tag=` is the source of truth for the home browser (clear, unknown tag,
 *    and Back/Forward between URL values).
 */
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  pathname: "/knowledge",
  search: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

import { KnowledgeBrowser } from "./kb-browser";
import { KbSideMenuFrame, useKbSearch } from "./kb-nav";
import type { KbCataloguePayload, KbSearchHit } from "@/lib/knowledge";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hit(slug: string): KbSearchHit {
  return {
    slug,
    title: slug,
    summary: "",
    snippet: "",
    categoryTitle: null,
    tags: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const CATALOGUE: KbCataloguePayload = {
  categories: [],
  articles: [],
  tags: [{ slug: "printing", label: "چاپ" }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.push.mockReset();
  nav.replace.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useKbSearch", () => {
  it("ignores a stale response that resolves after a newer query", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    fetchMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useKbSearch());
    act(() => result.current.onQueryChange("ف"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.onQueryChange("فروش"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The first request was superseded: its signal is aborted.
    const firstSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      second.resolve(jsonResponse({ results: [hit("newer")] }));
    });
    await waitFor(() => expect(result.current.results?.[0]?.slug).toBe("newer"));

    await act(async () => {
      first.resolve(jsonResponse({ results: [hit("stale")] }));
    });
    expect(result.current.results?.[0]?.slug).toBe("newer");
  });

  it("clears the timer and request on unmount", async () => {
    const deferred = deferredResponse();
    fetchMock.mockReturnValue(deferred.promise);
    const { result, unmount } = renderHook(() => useKbSearch());
    act(() => result.current.onQueryChange("صندوق"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("surfaces a failure with a retry that succeeds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unexpected" }, 500));
    const { result } = renderHook(() => useKbSearch());
    act(() => result.current.onQueryChange("صندوق"));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.searching).toBe(false);
    expect(result.current.results).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [hit("pos-basics")] }));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.results?.[0]?.slug).toBe("pos-basics"));
    expect(result.current.error).toBe("");
  });

  it("clearing the query resets results, error and loading", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unexpected" }, 500));
    const { result } = renderHook(() => useKbSearch());
    act(() => result.current.onQueryChange("صندوق"));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() => result.current.clear());
    expect(result.current.error).toBe("");
    expect(result.current.results).toBeNull();
    expect(result.current.searching).toBe(false);
  });
});

describe("the phone side-menu drawer", () => {
  const catalogue: KbCataloguePayload = {
    categories: [],
    articles: [],
    tags: [],
  };

  it("moves focus in, traps Tab, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <KbSideMenuFrame
        catalogue={catalogue}
        query=""
        onQueryChange={() => undefined}
        searching={false}
      />,
    );
    const trigger = screen.getByRole("button", { name: /فهرست راهنماها/ });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "بستن فهرست" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // Close is the first focusable; Shift+Tab wraps to the last one.
    await user.tab({ shift: true });
    const searchBox = within(dialog).getByRole("searchbox", {
      name: "جست‌وجو در پایگاه دانش",
    });
    expect(document.activeElement).toBe(searchBox);
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe("KnowledgeBrowser tag filter and the URL", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse(CATALOGUE));
  });

  it("clears ?tag= on the route as well as in the UI", async () => {
    nav.search = new URLSearchParams("tag=printing");
    const user = userEvent.setup();
    render(<KnowledgeBrowser initialTag="printing" />);

    await screen.findByRole("heading", { name: "#چاپ" });
    await user.click(screen.getByRole("button", { name: "حذف فیلتر برچسب" }));

    expect(nav.push).toHaveBeenCalledWith("/knowledge", { scroll: false });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "#چاپ" })).toBeNull());
  });

  it("shows an explicit state for an unknown tag instead of a raw empty filter", async () => {
    nav.search = new URLSearchParams("tag=removed-tag");
    const user = userEvent.setup();
    render(<KnowledgeBrowser initialTag="removed-tag" />);

    await screen.findByRole("heading", { name: "برچسب پیدا نشد" });
    await user.click(screen.getByRole("button", { name: "نمایش همهٔ راهنماها" }));
    expect(nav.push).toHaveBeenCalledWith("/knowledge", { scroll: false });
  });

  it("follows Back/Forward between tag values and home", async () => {
    const { rerender } = render(<KnowledgeBrowser initialTag="" />);
    await screen.findByRole("heading", { name: "مرکز آموزش" });

    nav.search = new URLSearchParams("tag=printing");
    rerender(<KnowledgeBrowser initialTag="" />);
    await screen.findByRole("heading", { name: "#چاپ" });

    nav.search = new URLSearchParams();
    rerender(<KnowledgeBrowser initialTag="" />);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "#چاپ" })).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "مرکز آموزش" })).toBeTruthy();
  });

  it("shows a retry when the catalogue fails instead of a permanent skeleton", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unexpected" }, 500));
    const user = userEvent.setup();
    render(<KnowledgeBrowser initialTag="" />);

    await screen.findByText("مرکز آموزش بارگذاری نشد");
    fetchMock.mockResolvedValueOnce(jsonResponse(CATALOGUE));
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByRole("heading", { name: "مرکز آموزش" });
  });
});
