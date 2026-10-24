// @vitest-environment jsdom

/**
 * Issue #944 — rendered contracts for the shared WP store provider, against a
 * fake server:
 *
 *  - **OVR-02** a 403 / 500 / offline first read is an error with a retry,
 *    never the «هنوز فروشگاهی متصل نیست» empty state; only a successful empty
 *    list is; a failed *refresh* keeps the last good list.
 *  - **OVR-05** a late response from an older read cannot overwrite a newer
 *    selection; a deleted remembered store falls back; the URL is written
 *    only when it differs.
 *  - **OVR-01** the list comes from the manager's own endpoint and the
 *    abilities handed in are what `can()` answers.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(""),
  pathname: "/websites/wp",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => nav.params,
  usePathname: () => nav.pathname,
}));

import { useWpStore, WP_CONNECTIONS_ENDPOINT, WpStoreProvider } from "./wp-store-context";

type Deferred = { resolve: (value: { status: number; data: unknown }) => void; reject: (error: Error) => void };

let pending: Deferred[] = [];
let autoReply: (() => { status: number; data: unknown }) | null = null;

function installFetch() {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      expect(url).toBe(WP_CONNECTIONS_ENDPOINT);
      return new Promise<Response>((resolve, reject) => {
        const settle = (reply: { status: number; data: unknown }) =>
          resolve(
            new Response(JSON.stringify(reply.data), {
              status: reply.status,
              headers: { "Content-Type": "application/json" },
            }),
          );
        const entry: Deferred = { resolve: settle, reject };
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        if (autoReply) settle(autoReply());
        else pending.push(entry);
      });
    }),
  );
}

const store = (id: string, name = `Store ${id}`) => ({
  id,
  name,
  linkMode: "rest_api" as const,
  status: "active",
  baseUrl: `https://${id}.example.com`,
});

function Probe() {
  const { connections, loadState, loadError, selectedId, setSelectedId, reloadConnections, can } = useWpStore();
  return (
    <div>
      <output data-testid="state">{loadState}</output>
      <output data-testid="error">{loadError ? `${loadError.status}:${loadError.code}` : ""}</output>
      <output data-testid="count">{connections ? String(connections.length) : "null"}</output>
      <output data-testid="selected">{selectedId}</output>
      <output data-testid="can-sync">{can("sync") ? "yes" : "no"}</output>
      <button onClick={() => setSelectedId("b")}>pick-b</button>
      <button onClick={() => void reloadConnections()}>reload</button>
    </div>
  );
}

beforeEach(() => {
  installFetch();
  autoReply = null;
  nav.replace.mockReset();
  nav.params = new URLSearchParams("");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WpStoreProvider — load states (OVR-02)", () => {
  it("shows a retryable error, not the empty state, when the first read is 403", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 403, data: { error: "forbidden" } }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("دسترسی");
    expect(alert.textContent).not.toContain("هنوز فروشگاهی متصل نیست");
    expect(screen.queryByTestId("count")).toBeNull();

    // Retry — a successful read then renders the children with the list.
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve({ status: 200, data: { connections: [store("a")] } }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    expect(screen.getByTestId("state").textContent).toBe("loaded");
    expect(screen.getByTestId("selected").textContent).toBe("a");
  });

  it("an offline first read (network failure) is an error too", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].reject(new TypeError("fetch failed")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ارتباط با سرور");
  });

  it("a signed-out first read offers login instead of retry", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 401, data: { error: "unauthorized" } }));
    expect(await screen.findByRole("link", { name: "ورود دوباره" })).toBeTruthy();
  });

  it("only a successful empty list is the loaded-empty state", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [] } }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("0"));
    expect(screen.getByTestId("state").textContent).toBe("loaded");
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("a failed refresh keeps the last good list and reports the failure", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));

    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve({ status: 500, data: { error: "internal" } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error"));
    expect(screen.getByTestId("count").textContent).toBe("2");
    expect(screen.getByTestId("selected").textContent).toBe("a");
    expect(screen.getByTestId("error").textContent).toBe("500:internal");
  });
});

describe("WpStoreProvider — selection and races (OVR-05)", () => {
  it("a late response from an older read does not overwrite the member's newer pick", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("a"));

    // Start a reload (slow), then pick B, then start another reload (fast).
    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(pending).toHaveLength(2));
    fireEvent.click(screen.getByText("pick-b"));
    expect(screen.getByTestId("selected").textContent).toBe("b");
    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(pending).toHaveLength(3));

    // The fast (newer) one lands first and keeps B …
    act(() => pending[2].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    expect(screen.getByTestId("selected").textContent).toBe("b");
    // … and the slow (older) one is ignored even though it resolves later.
    act(() => pending[1].resolve({ status: 200, data: { connections: [store("a")] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("selected").textContent).toBe("b");
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("follows ?store= over the remembered store, and falls back when the remembered store is gone", async () => {
    localStorage.setItem("wp-manager:selected-connection:biz-1", "gone");
    nav.params = new URLSearchParams("store=b&tab=x");
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("b"));
    // URL already names B: no replace needed, other params untouched.
    expect(nav.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBe("b");
  });

  it("writes ?store= once, preserving the other query parameters", async () => {
    nav.params = new URLSearchParams("tab=orders");
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a")] } }));
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("a"));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    const [href] = nav.replace.mock.calls[0];
    const url = new URL(href, "https://app.test");
    expect(url.pathname).toBe("/websites/wp");
    expect(url.searchParams.get("tab")).toBe("orders");
    expect(url.searchParams.get("store")).toBe("a");
  });

  it("another business's remembered store is never applied", async () => {
    localStorage.setItem("wp-manager:selected-connection:biz-2", "b");
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("a"));
  });
});

describe("WpStoreProvider — abilities (OVR-01)", () => {
  it("answers can() from the abilities the layout handed in", async () => {
    autoReply = () => ({ status: 200, data: { connections: [store("a")] } });
    const { unmount } = render(
      <WpStoreProvider businessId="biz-1" abilities={["view"]}>
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("can-sync").textContent).toBe("no"));
    unmount();
    render(
      <WpStoreProvider businessId="biz-1" abilities={["view", "sync"]}>
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("can-sync").textContent).toBe("yes"));
  });
});
