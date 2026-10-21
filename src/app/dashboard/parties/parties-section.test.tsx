// @vitest-environment jsdom

/**
 * Issue #909 item 4 — the directory's list load (`load()` in
 * parties-section.tsx) never explicitly blanks `parties` before a refetch
 * (a same-scope refresh already preserved rows), but three real gaps were
 * found on audit: a stale error banner was never cleared when a later load
 * succeeded, a same-scope refresh that itself failed still zeroed a
 * perfectly good list and its total, and the very first load gave no
 * "still working" feedback. All three are exercised here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import { partyScopeFor } from "@/lib/parties-scopes";
import { PartiesSection, type PartyListRow } from "./parties-section";

afterEach(cleanup);

function partyRow(overrides: Partial<PartyListRow> = {}): PartyListRow {
  return {
    id: "party-1",
    displayName: "فروشگاه آرام",
    status: true,
    roles: ["Customer"],
    ...overrides,
  };
}

function listPayload(parties: PartyListRow[] = []) {
  return { parties, total: parties.length, businessId: "biz-1" };
}

function stubOtherRoutes() {
  return {
    "/api/parties/categories": () => ({ ok: true, status: 200, json: async () => ({ categories: [] }) }),
  };
}

const SCOPE = partyScopeFor("accounting");

function renderSection(permissions: string[] = []) {
  return render(<PartiesSection scope={SCOPE} role="owner" permissions={permissions} />);
}

describe("PartiesSection — a same-scope refresh (issue #909 item 4)", () => {
  it("clears a stale error banner once a later same-scope load succeeds", async () => {
    let listCall = 0;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/parties?")) {
          listCall += 1;
          // 1st: succeeds. 2nd (after the archive below): fails, banner
          // shown. 3rd (after archiving again): succeeds — must not still
          // show the previous failure's banner over fresh, good data.
          if (listCall === 2) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
          return { ok: true, status: 200, json: async () => listPayload([partyRow()]) };
        }
        if (url === "/api/parties/party-1" && init?.method === "PUT") {
          return { ok: true, status: 200, json: async () => ({ party: partyRow() }) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection([PERMISSIONS.partiesManage]);
    await screen.findAllByText("فروشگاه آرام");

    const archiveButton = () => screen.getAllByRole("button", { name: 'بایگانی «فروشگاه آرام»' })[0];
    fireEvent.click(archiveButton());
    await waitFor(() => expect(listCall).toBe(2));
    expect(await screen.findByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeTruthy();

    fireEvent.click(archiveButton());
    await waitFor(() => expect(listCall).toBe(3));
    await waitFor(() => expect(screen.queryByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeNull());
  });

  it("keeps the rows on screen through a same-scope refresh, and a failed refresh leaves them alone", async () => {
    let listCall = 0;
    let toggleCalled = false;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/parties?")) {
          listCall += 1;
          if (listCall === 1) return { ok: true, status: 200, json: async () => listPayload([partyRow()]) };
          // The refresh after a successful archive — the same page/query —
          // itself fails this time.
          return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        }
        if (url === "/api/parties/party-1" && init?.method === "PUT") {
          toggleCalled = true;
          return { ok: true, status: 200, json: async () => ({ party: partyRow({ status: false }) }) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    // `partiesManage` draws the archive control this test uses as a
    // same-scope refresh trigger (a successful mutation bumps `refreshKey`
    // without changing the page or any filter).
    renderSection([PERMISSIONS.partiesManage]);
    await screen.findAllByText("فروشگاه آرام");

    const archiveButtons = screen.getAllByRole("button", { name: 'بایگانی «فروشگاه آرام»' });
    fireEvent.click(archiveButtons[0]);
    await waitFor(() => expect(toggleCalled).toBe(true));
    await waitFor(() => expect(listCall).toBe(2));
    // Still there — a failed background refresh does not erase a good directory.
    expect(screen.getAllByText("فروشگاه آرام").length).toBeGreaterThan(0);
    expect(await screen.findByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeTruthy();
  });

  it("names the very first load as slow after ~5s, and stops once it settles", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      const deferred = new Promise((r) => {
        resolve = r;
      });
      const routes = stubOtherRoutes();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.startsWith("/api/parties?")) return deferred;
          for (const [prefix, handler] of Object.entries(routes)) {
            if (url.startsWith(prefix)) return handler();
          }
          throw new Error(`unexpected fetch ${url}`);
        }),
      );
      renderSection();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeTruthy();

      resolve({ ok: true, status: 200, json: async () => listPayload([partyRow()]) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeNull();
      expect(screen.getAllByText("فروشگاه آرام").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
