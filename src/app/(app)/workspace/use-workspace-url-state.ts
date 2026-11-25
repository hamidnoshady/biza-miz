"use client";

/**
 * URL-owned view state for the workspace sections (issue #907 F11).
 *
 * The audit found the opposite arrangement: a shortcut's `?mine=true` or
 * `?expiring=30` was copied into `useState` once at mount, so a query-only
 * navigation inside an already mounted section left the previous filter in
 * charge, and a member's own filter change was never written back to the
 * address. The URL is the canonical statement of "which rows am I looking at",
 * which is what makes a shared link, a reload and the browser's back button
 * agree with the screen.
 *
 * Reads go through `useSearchParams` so server rendering and the first client
 * render agree; writes use `history.replaceState` rather than the router, the
 * same rule `workspace-manager.tsx` follows: this changes the address of the
 * current view, it is not navigation. Next keeps `useSearchParams` in sync, so
 * back/forward re-applies the stored filter instead of leaving a stale one.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export function useWorkspaceUrlState(
  key: string,
  fallback = "",
): [string, (next: string) => void] {
  const params = useSearchParams();
  // `useSearchParams` returns null while a page is static or outside a router
  // (a section rendered in a unit test is the common case); the fallback keeps
  // that path working instead of throwing on the first render.
  const fromUrl = params?.get(key) ?? fallback;
  const [value, setValue] = useState(fromUrl);

  useEffect(() => {
    setValue(fromUrl);
  }, [fromUrl]);

  const set = useCallback(
    (next: string) => {
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (next) url.searchParams.set(key, next);
      else url.searchParams.delete(key);
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      setValue(next);
    },
    [key],
  );

  return [value, set];
}

/** A boolean parameter, stored as `key=true` and absent when off. */
export function useWorkspaceUrlFlag(
  key: string,
  fallback = false,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useWorkspaceUrlState(key, fallback ? "true" : "");
  return [value === "true", (next) => setValue(next ? "true" : "")];
}
