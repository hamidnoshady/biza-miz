// @vitest-environment jsdom

/**
 * Issue #909 §6 — `load()` (programs + recent customers + repurchase due)
 * ran once, on mount, and nothing ever called it again: a failed read said
 * «دوباره تلاش کنید» with no control anywhere on screen that retried it.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { LoyaltySection } from "./loyalty-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const abilities = {
  manageLoyaltyPrograms: true,
  redeemPoints: true,
  issueStoreCredit: true,
  payOutStoreCredit: true,
};

function renderSection() {
  return render(
    <MoneyProvider unit="rial">
      <LoyaltySection abilities={abilities} />
    </MoneyProvider>,
  );
}

describe("LoyaltySection", () => {
  it("offers a working Retry when the initial read fails, instead of a dead-end message", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        attempt += 1;
        const firstPass = attempt <= 3;
        if (url === "/api/loyalty/programs") {
          return firstPass
            ? { ok: false, status: 500, json: async () => ({ error: "server_error" }) }
            : { ok: true, status: 200, json: async () => ({ programs: [] }) };
        }
        if (url.startsWith("/api/parties?roles=Customer")) {
          return { ok: true, status: 200, json: async () => ({ customers: [] }) };
        }
        if (url === "/api/loyalty/repurchase") {
          return { ok: true, status: 200, json: async () => ({ customers: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    const user = userEvent.setup();
    renderSection();

    const retry = await screen.findByRole("button", { name: "تلاش دوباره" });
    expect(screen.getByText(/بارگذاری .*ناموفق بود/)).toBeTruthy();

    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "تلاش دوباره" })).toBeNull());
  });
});
