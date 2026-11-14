// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupHealthNotice } from "./backup-health-notice";

afterEach(() => {
  // Vitest globals are disabled, so RTL cannot register automatic cleanup.
  // Unmount while jsdom and the fetch stub still exist: the effect owns a
  // polling interval, a focus listener and an in-flight request.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function healthResponse(level: "ok" | "warning" | "error", reason: string) {
  return new Response(JSON.stringify({ health: { alert: { level, reason } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("persistent backup health notice", () => {
  it("releases polling, focus refresh and the pending request on unmount", async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => response);
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<BackupHealthNotice />);
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even a response that ignores abort must settle before jsdom teardown,
    // without scheduling a health update for the unmounted component.
    await act(async () => { resolveResponse(healthResponse("error", "local_stale")); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays hidden when the canonical health calculation is ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthResponse("ok", "ok")));
    render(<BackupHealthNotice />);
    await waitFor(() => expect(screen.queryByLabelText("بررسی سلامت پشتیبان‌گیری")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a persistent stale-backup warning with a recovery link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthResponse("error", "local_stale")));
    render(<BackupHealthNotice />);
    expect((await screen.findByRole("alert")).textContent).toContain("نسخهٔ پشتیبان تازه‌ای وجود ندارد");
    expect(screen.getByRole("link", { name: "بررسی پشتیبان‌گیری" }).getAttribute("href")).toBe("/settings/backup");
  });
});
