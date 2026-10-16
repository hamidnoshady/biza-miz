// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiConversationsSidebar,
  type ConversationSummary,
} from "./ai-conversations-sidebar";

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

vi.mock("@/components/feature-lock", () => ({
  useFeatureLocked: () => false,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConversation(
  id: string,
  title: string,
  lastMessageAt = "2026-10-15T10:00:00.000Z",
): ConversationSummary {
  return {
    id,
    mode: "dashboard",
    title,
    lastMessageAt,
    createdAt: lastMessageAt,
    projectId: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AiConversationsSidebar — deterministic request ownership regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ignores a delayed pagination (loadOlder) response when a newer refresh or search supersedes it", async () => {
    const page1 = createDeferred<Response>();
    const stalePage2 = createDeferred<Response>();
    const refreshedPage1 = createDeferred<Response>();

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => page1.promise)
      .mockImplementationOnce(() => stalePage2.promise)
      .mockImplementationOnce(() => refreshedPage1.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    // Resolve initial page 1 with hasMore=true and cursor pointing to conv-1
    await act(async () => {
      page1.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-1", "گفتگوی صفحه اول")],
          hasMore: true,
          nextCursor: {
            before: "2026-10-15T09:00:00.000Z",
            beforeId: "11111111-1111-4111-8111-111111111111",
          },
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("گفتگوی صفحه اول")).toBeTruthy();

    // Start pagination (loadOlder) — remains in-flight
    const loadMoreBtn = screen.getByRole("button", {
      name: /نمایش گفتگوهای قدیمی‌تر/,
    });
    await act(async () => {
      fireEvent.click(loadMoreBtn);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Bump refreshToken while loadOlder is still pending
    rerender(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={1}
        onSelect={vi.fn()}
      />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Resolve the newer refresh first (hasMore=false, no older pages)
    await act(async () => {
      refreshedPage1.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-fresh", "گفتگوی تازه")],
          hasMore: false,
          nextCursor: null,
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("گفتگوی تازه")).toBeTruthy();
    expect(screen.queryByText("گفتگوی صفحه اول")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /نمایش گفتگوهای قدیمی‌تر/ }),
    ).toBeNull();

    // Now the stale pagination response resolves late with an older item + hasMore=true
    await act(async () => {
      stalePage2.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-stale-old", "گفتگوی قدیمی باطل")],
          hasMore: true,
          nextCursor: {
            before: "2026-10-14T09:00:00.000Z",
            beforeId: "22222222-2222-4222-8222-222222222222",
          },
        }),
      );
      await Promise.resolve();
    });

    // Stale page 2 must NOT append to the newer list or restore hasMore/nextCursor
    expect(screen.getByText("گفتگوی تازه")).toBeTruthy();
    expect(screen.queryByText("گفتگوی قدیمی باطل")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /نمایش گفتگوهای قدیمی‌تر/ }),
    ).toBeNull();
  });

  it("ignores a delayed search response when a newer search query finishes first", async () => {
    const initialLoad = createDeferred<Response>();
    const slowSearchA = createDeferred<Response>();
    const fastSearchB = createDeferred<Response>();

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementationOnce(() => slowSearchA.promise)
      .mockImplementationOnce(() => fastSearchB.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    await act(async () => {
      initialLoad.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-init", "گفتگوی اولیه")],
          hasMore: false,
          nextCursor: null,
        }),
      );
      await Promise.resolve();
    });

    const searchInput = screen.getByLabelText("جست‌وجوی گفتگو");

    // Type query A ("فروش") and advance debounce timer
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "فروش" } });
      vi.advanceTimersByTime(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("q=%D9%81%D8%B1%D9%88%D8%B4");

    // Type query B ("انبار") before query A resolves
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "انبار" } });
      vi.advanceTimersByTime(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("q=%D8%A7%D9%86%D8%A8%D8%A7%D8%B1");

    // Query B resolves first
    await act(async () => {
      fastSearchB.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-inv", "بررسی موجودی انبار")],
          hasMore: false,
          nextCursor: null,
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("بررسی موجودی انبار")).toBeTruthy();

    // Query A resolves late with different items and cursor
    await act(async () => {
      slowSearchA.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-sales", "گزارش فروش ماهانه")],
          hasMore: true,
          nextCursor: {
            before: "2026-10-10T00:00:00.000Z",
            beforeId: "33333333-3333-4333-8333-333333333333",
          },
        }),
      );
      await Promise.resolve();
    });

    // Must still show only query B's results and hasMore=false
    expect(screen.getByText("بررسی موجودی انبار")).toBeTruthy();
    expect(screen.queryByText("گزارش فروش ماهانه")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /نمایش گفتگوهای قدیمی‌تر/ }),
    ).toBeNull();
  });

  it("ignores delayed failures from superseded reload or pagination requests", async () => {
    const slowFailingReload = createDeferred<Response>();
    const succeedingRefresh = createDeferred<Response>();

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => slowFailingReload.promise)
      .mockImplementationOnce(() => succeedingRefresh.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    // Trigger a newer refresh before the initial request fails
    rerender(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={1}
        onSelect={vi.fn()}
      />,
    );

    await act(async () => {
      succeedingRefresh.resolve(
        jsonResponse({
          conversations: [makeConversation("conv-ok", "گفتگوی معتبر")],
          hasMore: false,
          nextCursor: null,
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("گفتگوی معتبر")).toBeTruthy();

    // Now the superseded first request fails with a 500
    await act(async () => {
      slowFailingReload.resolve(
        jsonResponse({ message: "خطای قدیمی سرور" }, 500),
      );
      await Promise.resolve();
    });

    // Must not overwrite the valid list with the stale error banner
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("گفتگوی معتبر")).toBeTruthy();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("ignores delayed responses and failures after component unmount", async () => {
    const pendingReload = createDeferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => pendingReload.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    unmount();

    await act(async () => {
      pendingReload.reject(new Error("خطای پس از خروج"));
      await Promise.resolve();
    });

    expect(toastError).not.toHaveBeenCalled();
  });

  it("maps browser network TypeError('Failed to fetch') to Persian error copy with Retry", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );

    render(
      <AiConversationsSidebar
        activeId={null}
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("خواندن گفتگوهای اخیر ممکن نشد.");
    expect(alert.textContent).not.toContain("Failed to fetch");
    expect(screen.getByRole("button", { name: "تلاش مجدد" })).toBeTruthy();
  });
});
