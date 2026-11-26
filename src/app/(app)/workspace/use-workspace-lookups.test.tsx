// @vitest-environment jsdom

/**
 * Issue #907 F10 — the one party picker hook.
 *
 * The debounce, the stale-response drop and the remembered selection used to
 * be copied into each section; these pin the shared copy so the three forms
 * cannot drift apart again.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/dashboard/ui", () => ({ api: apiMock }));

import { usePartyPicker, usePartyPickerList } from "./use-workspace-lookups";

const base = [
  { id: "1", name: "آلفا" },
  { id: "2", name: "بتا" },
];

type Reply = { ok: boolean; status: number; data: Record<string, unknown>; aborted: boolean };

interface Pending {
  url: string;
  resolve: (reply: Reply) => void;
}

let pending: Pending[];

function ok(data: Record<string, unknown>): Reply {
  return { ok: true, status: 200, data, aborted: false };
}

function searchUrl(index: number): URL {
  return new URL(pending[index].url, "http://local");
}

beforeEach(() => {
  pending = [];
  apiMock.mockReset();
  apiMock.mockImplementation(
    (url: string) => new Promise<Reply>((resolve) => pending.push({ url, resolve })),
  );
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Type a term and let the 250 ms debounce fire. */
async function search(setTerm: (term: string) => void, term: string) {
  act(() => setTerm(term));
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

describe("usePartyPicker (#907 F10)", () => {
  it("shows the lookups page until the term is long enough to search", async () => {
    const { result } = renderHook(() => usePartyPicker(base, "2"));
    expect(result.current.options).toEqual([
      { id: "1", label: "آلفا" },
      { id: "2", label: "بتا" },
    ]);

    await search(result.current.setTerm, "آ");
    expect(apiMock).not.toHaveBeenCalled();
    expect(result.current.options).toHaveLength(2);
  });

  it("says the embedded page is partial, and that searching reaches the rest", () => {
    const { result } = renderHook(() =>
      usePartyPicker(base, "", { total: 120, hasMore: true }),
    );
    expect(result.current.note).toBe(
      "۲ مورد از ۱۲۰ مورد نمایش داده شد؛ برای دیدن بقیه جست‌وجو کنید.",
    );
  });

  it("stays quiet when the embedded page is the whole directory", () => {
    const { result } = renderHook(() =>
      usePartyPicker(base, "", { total: 2, hasMore: false }),
    );
    expect(result.current.note).toBeUndefined();
  });

  it("debounces one request, then replaces the page with the server's rows and keeps the selection", async () => {
    const { result } = renderHook(() => usePartyPicker(base, "2"));
    await search(result.current.setTerm, "آلف");

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(searchUrl(0).searchParams.get("q")).toBe("آلف");
    expect(result.current.searching).toBe(true);

    await act(async () =>
      pending[0].resolve(
        ok({
          parties: [{ id: "9", name: "آلفا پارس" }],
          selected: [{ id: "2", name: "بتا" }],
          total: 40,
          hasMore: true,
        }),
      ),
    );

    // The match, and the selected row the page does not carry.
    expect(result.current.options).toEqual([
      { id: "2", label: "بتا" },
      { id: "9", label: "آلفا پارس" },
    ]);
    expect(result.current.searching).toBe(false);
    expect(result.current.note).toContain("۱ مورد از ۴۰");
  });

  it("drops a late answer for an earlier term", async () => {
    const { result } = renderHook(() => usePartyPicker(base, ""));
    await search(result.current.setTerm, "آلفا");
    await search(result.current.setTerm, "بتا");
    expect(pending).toHaveLength(2);

    await act(async () =>
      pending[1].resolve(ok({ parties: [{ id: "2", name: "بتا" }], selected: [], total: 1, hasMore: false })),
    );
    await act(async () =>
      pending[0].resolve(ok({ parties: [{ id: "1", name: "آلفا" }], selected: [], total: 1, hasMore: false })),
    );

    expect(result.current.options).toEqual([{ id: "2", label: "بتا" }]);
  });

  it("resolves a selection the embedded page does not carry, before any term", async () => {
    const { result } = renderHook(() => usePartyPicker(base, "77"));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(searchUrl(0).searchParams.get("ids")).toBe("77");
    expect(searchUrl(0).searchParams.get("q")).toBeNull();
    expect(result.current.options).toEqual([
      { id: "1", label: "آلفا" },
      { id: "2", label: "بتا" },
    ]);

    await act(async () =>
      pending[0].resolve(
        ok({ parties: [], selected: [{ id: "77", name: "طرف حساب دوردست" }] }),
      ),
    );
    expect(result.current.options).toEqual([
      { id: "77", label: "طرف حساب دوردست" },
      { id: "1", label: "آلفا" },
      { id: "2", label: "بتا" },
    ]);
  });

  it("still names a party chosen from a search after the box is cleared", async () => {
    const { result } = renderHook(() => usePartyPicker(base, "77"));
    await act(async () =>
      pending[0].resolve(
        ok({ parties: [], selected: [{ id: "77", name: "طرف حساب دوردست" }] }),
      ),
    );
    await search(result.current.setTerm, "دور");
    await act(async () =>
      pending[1].resolve(
        ok({
          parties: [],
          selected: [{ id: "77", name: "طرف حساب دوردست" }],
          total: 0,
          hasMore: false,
        }),
      ),
    );

    act(() => result.current.setTerm(""));
    expect(result.current.options).toEqual([
      { id: "77", label: "طرف حساب دوردست" },
      { id: "1", label: "آلفا" },
      { id: "2", label: "بتا" },
    ]);
  });
});

describe("usePartyPickerList (#907 F10)", () => {
  it("searches with every chosen id so a list keeps its off-page rows", async () => {
    const listBase = [
      { id: "1", name: "آلفا" },
      { id: "2", name: "بتا" },
      { id: "3", name: "گاما" },
    ];
    const { result } = renderHook(() => usePartyPickerList(listBase, ["2", "3"]));
    // "1" is on the page; only the rows it does not carry are resolved.
    expect(apiMock).not.toHaveBeenCalled();

    await search(result.current.setTerm, "دور");
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(searchUrl(0).searchParams.get("ids")).toBe("2,3");

    await act(async () =>
      pending[0].resolve(
        ok({
          parties: [{ id: "9", name: "دوردست" }],
          selected: [{ id: "2", name: "بتا" }, { id: "3", name: "گاما" }],
          total: 1,
          hasMore: false,
        }),
      ),
    );
    expect(result.current.options).toEqual([
      { id: "2", label: "بتا" },
      { id: "3", label: "گاما" },
      { id: "9", label: "دوردست" },
    ]);
  });

  it("says its page is partial before anything is typed, too", () => {
    const listBase = [
      { id: "1", name: "آلفا" },
      { id: "2", name: "بتا" },
    ];
    const { result } = renderHook(() =>
      usePartyPickerList(listBase, ["2"], { total: 40, hasMore: true }),
    );
    expect(result.current.note).toBe(
      "۲ مورد از ۴۰ مورد نمایش داده شد؛ برای دیدن بقیه جست‌وجو کنید.",
    );
  });
});
