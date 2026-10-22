// @vitest-environment jsdom

/**
 * Issue #909 §13 — "401 follows an expired-session path instead of a generic
 * label." `api()` (src/app/dashboard/ui.tsx) dispatches `biza:session-expired`
 * when, and only when, a response normalizes to a 401 `{ error: "unauthorized" }`
 * (see src/app/dashboard/ui.test.ts for that half of the contract). This file
 * covers the listener that turns that event into an actual recovery path.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExpiryListener } from "./session-expiry-listener";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

afterEach(() => {
  cleanup();
  replace.mockClear();
});

function dispatchExpired() {
  act(() => {
    window.dispatchEvent(new CustomEvent("biza:session-expired"));
  });
}

describe("SessionExpiryListener", () => {
  it("navigates to /login with the current path preserved as ?next= on the event", () => {
    window.history.pushState({}, "", "/accounting/ledger?from=2026-01-01");
    render(<SessionExpiryListener />);

    dispatchExpired();

    expect(replace).toHaveBeenCalledTimes(1);
    const to = replace.mock.calls[0][0] as string;
    expect(to.startsWith("/login?")).toBe(true);
    expect(decodeURIComponent(to)).toContain("/accounting/ledger?from=2026-01-01");
  });

  it("fires at most once even when several concurrent reads all expire together", () => {
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);

    dispatchExpired();
    dispatchExpired();
    dispatchExpired();

    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the event ever fires", () => {
    window.history.pushState({}, "", "/dashboard");
    render(<SessionExpiryListener />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    window.history.pushState({}, "", "/dashboard");
    const { unmount } = render(<SessionExpiryListener />);
    unmount();

    dispatchExpired();

    expect(replace).not.toHaveBeenCalled();
  });
});
