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
 *  - **OVR-05** (continued) browser back/forward follows `?store=`, a
 *    business switch never carries the old business's list or pick across, and
 *    two open tabs each keep their own selection.
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
  const { connections, loadState, loadError, connectionsError, selectedId, setSelectedId, reloadConnections, can } = useWpStore();
  return (
    <div>
      <output data-testid="state">{loadState}</output>
      <output data-testid="error">{loadError ? `${loadError.status}:${loadError.code}` : ""}</output>
      <output data-testid="connections-error">{connectionsError ?? ""}</output>
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
    expect(screen.getByTestId("connections-error").textContent).not.toBe("");
  });

  it("does not treat a malformed successful response as an empty connection list", async () => {
    render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a")] } }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));

    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve({ status: 200, data: { error: "unexpected_shape" } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error"));
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("connections-error").textContent).toContain("قالب نامعتبر");
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

describe("WpStoreProvider — back/forward, business switch, two tabs (OVR-05)", () => {
  async function renderLoaded(businessId = "biz-1", ids = ["a", "b"]) {
    const view = render(
      <WpStoreProvider businessId={businessId}>
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0].resolve({ status: 200, data: { connections: ids.map((id) => store(id)) } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    return view;
  }
  const rerenderWith = (view: ReturnType<typeof render>, businessId = "biz-1") =>
    view.rerender(
      <WpStoreProvider businessId={businessId}>
        <Probe />
      </WpStoreProvider>,
    );

  it("browser back/forward changing ?store= moves the selection without a new fetch or a URL write", async () => {
    const view = await renderLoaded();
    expect(screen.getByTestId("selected").textContent).toBe("a");
    nav.replace.mockClear();

    nav.params = new URLSearchParams("store=b");
    rerenderWith(view);
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("b"));
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBe("b");

    nav.params = new URLSearchParams("store=a");
    rerenderWith(view);
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("a"));

    // Following the URL is not a navigation of its own: nothing was refetched
    // and nothing was written back to the address bar (no replace loop).
    expect(pending).toHaveLength(1);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("ignores a ?store= that names no store we have, and a URL that drops the parameter", async () => {
    const view = await renderLoaded();
    nav.params = new URLSearchParams("store=b");
    rerenderWith(view);
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("b"));

    nav.params = new URLSearchParams("store=deleted-elsewhere");
    rerenderWith(view);
    nav.params = new URLSearchParams("tab=orders");
    rerenderWith(view);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("selected").textContent).toBe("b");
  });

  it("a later reload keeps the store the member reached by back/forward", async () => {
    const view = await renderLoaded();
    nav.params = new URLSearchParams("store=b");
    rerenderWith(view);
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("b"));

    fireEvent.click(screen.getByText("reload"));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    expect(screen.getByTestId("selected").textContent).toBe("b");
  });

  it("a business switch drops the old business's list and pick, then resolves against the new list", async () => {
    const view = await renderLoaded("biz-1", ["a", "b"]);
    fireEvent.click(screen.getByText("pick-b"));
    expect(screen.getByTestId("selected").textContent).toBe("b");
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBe("b");

    rerenderWith(view, "biz-2");
    await waitFor(() => expect(pending).toHaveLength(2));
    // Until biz-2's own list arrives nothing of biz-1's stores may be on screen.
    expect(screen.queryByTestId("count")).toBeNull();

    // biz-2 happens to own a store with the same id as biz-1's pick: the pick
    // is biz-1's, not biz-2's, so the first store wins.
    act(() => pending[1].resolve({ status: 200, data: { connections: [store("a"), store("b")] } }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    expect(screen.getByTestId("selected").textContent).toBe("a");
    expect(localStorage.getItem("wp-manager:selected-connection:biz-2")).toBe("a");
    // biz-1's remembered choice is untouched by the switch.
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBe("b");
  });

  it("a response still in flight for the old business cannot land after the switch", async () => {
    const view = render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    rerenderWith(view, "biz-2");
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1].resolve({ status: 200, data: { connections: [store("c")] } }));
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("c"));
    act(() => pending[0].resolve({ status: 200, data: { connections: [store("a")] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("selected").textContent).toBe("c");
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBeNull();
  });

  it("two open tabs each keep their own selection; a new tab starts from the remembered store", async () => {
    autoReply = () => ({ status: 200, data: { connections: [store("a"), store("b")] } });
    const tabOne = render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("a"));
    fireEvent.click(screen.getByText("pick-b"));
    expect(localStorage.getItem("wp-manager:selected-connection:biz-1")).toBe("b");

    // Tab two opens without ?store= and picks up what tab one remembered …
    nav.params = new URLSearchParams("");
    const tabTwo = render(
      <WpStoreProvider businessId="biz-1">
        <Probe />
      </WpStoreProvider>,
      { container: document.body.appendChild(document.createElement("div")) },
    );
    await waitFor(() => expect(screen.getAllByTestId("selected")[1]?.textContent).toBe("b"));

    // … and when another tab writes the shared storage key, an open tab does
    // not jump stores under the member's hands: the selection is per tab,
    // the stored value only seeds a tab that has none yet.
    localStorage.setItem("wp-manager:selected-connection:biz-1", "a");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "wp-manager:selected-connection:biz-1", newValue: "a", oldValue: "b", storageArea: localStorage }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const selected = screen.getAllByTestId("selected").map((node) => node.textContent);
    expect(selected).toEqual(["b", "b"]);
    tabOne.unmount();
    tabTwo.unmount();
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
