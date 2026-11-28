// @vitest-environment jsdom

/**
 * Issue #909 §13 — "401 follows an expired-session path instead of a generic
 * label." `api()` (src/app/dashboard/ui.tsx) dispatches `biza:session-expired`
 * when, and only when, a response normalizes to a 401 `{ error: "unauthorized" }`
 * (see src/app/dashboard/ui.test.ts for that half of the contract). This file
 * covers the listener that turns that event into an actual recovery path.
 *
 * Issue #1585 added one step in front of that path: a dead access session is
 * not necessarily the end of the session, so the listener first asks
 * `/api/auth/refresh` whether this browser's remembered login can mint a new
 * one. The assertions below are unchanged in what they demand — one navigation,
 * `?next=` preserved, fires once — they simply await the request the listener
 * now makes. Two cases are added for the new branch.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionExpiryListener } from "./session-expiry-listener";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

beforeEach(() => {
  // Default: no remembered login — the ordinary sign-in redirect.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "reauth_required" }), { status: 401 })),
  );
});

afterEach(() => {
  cleanup();
  replace.mockClear();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

async function dispatchExpired() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("biza:session-expired"));
  });
}

describe("SessionExpiryListener", () => {
  it("navigates to /login with the current path preserved as ?next= on the event", async () => {
    window.history.pushState({}, "", "/accounting/ledger?from=2026-01-01");
    render(<SessionExpiryListener />);

    await dispatchExpired();

    expect(replace).toHaveBeenCalledTimes(1);
    const to = replace.mock.calls[0][0] as string;
    expect(to.startsWith("/login?")).toBe(true);
    expect(decodeURIComponent(to)).toContain("/accounting/ledger?from=2026-01-01");
  });

  it("fires at most once even when several concurrent reads all expire together", async () => {
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);

    await dispatchExpired();
    await dispatchExpired();
    await dispatchExpired();

    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the event ever fires", () => {
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", async () => {
    window.history.pushState({}, "", "/dashboard");
    const { unmount } = render(<SessionExpiryListener />);
    unmount();

    await dispatchExpired();

    expect(replace).not.toHaveBeenCalled();
  });

  it("renews in place instead of signing out when the browser was remembered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);

    await dispatchExpired();

    expect(replace).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retries once on 409 (a sibling tab rotated first), then renews", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "concurrent_refresh" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);

    await dispatchExpired();
    // Let the bounded retry settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
});
