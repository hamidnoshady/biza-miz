"use client";

/**
 * The WordPress & WooCommerce manager's shared store selection.
 *
 * One provider at the layout level owns the connection list, the selected
 * store and the member's WP abilities; every section reads them from here so
 * switching stores on the overview is the same switch on products, orders,
 * content and the queue.
 *
 * Issue #944 hardened three things about it:
 *
 *  - **OVR-02** — a failed list read is an *error*, not an empty store. The
 *    old provider set `connections = []` on 403/500/offline, and the overview
 *    then told the owner to connect a store they had already connected.
 *    `loadState` now says `loading | loaded | error` on its own, the last
 *    good list survives a transient refresh failure, and `loadError` carries
 *    the status so the screen can tell "no access" from "server down".
 *  - **OVR-05** — responses are sequenced. Each reload takes a generation
 *    number and a stale response is dropped, so a slow first read cannot
 *    overwrite the store the member has since picked. The selection is
 *    resolved with one precedence: the member's own latest pick, then
 *    `?store=`, then the per-business remembered store, then the first
 *    store — always validated against the list, never a deleted id.
 *  - **OVR-01** — the list comes from the manager's own
 *    `GET /api/integrations/wp-manager/connections` (`woocommerce.view`), not
 *    the technical hub's list (`integrations.view`); and the member's WP
 *    abilities ride along so controls can disable themselves honestly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/app/dashboard/ui";
import { useFeatureLocked } from "@/components/feature-lock";
import type { WpAbility } from "@/lib/wp-access";
import type { ConnectionLite } from "./connection-lite";
import { describeStoreLoadFailure, WpStoreLoadError, WpStoreLoadingSkeleton } from "./wp-store-states";
import type { WpSectionCaps } from "./wp-routes";

export const WP_SELECTED_STORE_STORAGE_KEY = "wp-manager:selected-connection";
export const WP_CONNECTIONS_ENDPOINT = "/api/integrations/wp-manager/connections";

export type WpManagerConnection = ConnectionLite & {
  baseUrl?: string;
  syncProducts?: boolean;
  syncOrders?: boolean;
  syncCustomers?: boolean;
  pluginVersion?: string | null;
  pluginSiteUrl?: string | null;
  pluginSiteMismatchAt?: string | null;
  /** The capability set the plugin's last handshake reported; null before it, and for REST stores. */
  pluginCapabilities?: Record<string, unknown> | null;
  /** The store's own money unit — how its prices are denominated (issue #943). */
  currencyUnit?: "rial" | "toman";
  pushStock?: boolean;
  pushPrices?: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
  lastCatalogueSyncAt?: string | null;
  lastOrderSyncAt?: string | null;
  lastCustomerSyncAt?: string | null;
  lastContentSyncAt?: string | null;
  lastPluginSeenAt?: string | null;
  transportHealth?: { state: string; lastSeenAt: string | null; message?: string; checkedAt?: string };
  pluginHealth?: Record<string, unknown>;
};

export type WpStoreLoadState = "loading" | "loaded" | "error";

export interface WpStoreLoadFailure {
  /** HTTP status; 0 when the request never got a response (offline, aborted). */
  status: number;
  /** The server's error code, when it sent one. */
  code: string;
}

/**
 * The #942-era load vocabulary several sections still read beside the
 * richer `loadState`/`loadError` pair: a failed refresh of an already-read
 * list remains `ready`, with the failure carried by `connectionsError`.
 */
export type WpConnectionsState = "loading" | "ready" | "error";

/** What to tell the owner for each way the connection-list read can fail. */
export function wpConnectionsErrorMessage(status: number): string {
  if (status === 401) return "نشست شما پایان یافته است؛ صفحه را تازه کنید و دوباره وارد شوید.";
  if (status === 403) return "به فهرست فروشگاه‌ها دسترسی ندارید، یا قابلیت اتصال فروشگاه برای کسب‌وکار شما فعال نیست.";
  if (status === 0) return "ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی کنید و دوباره تلاش کنید.";
  if (status >= 500) return "خواندن فهرست فروشگاه‌ها در سرور با خطا مواجه شد؛ کمی بعد دوباره تلاش کنید.";
  return "خواندن فهرست فروشگاه‌ها ناموفق بود.";
}

interface WpStoreContextValue {
  /**
   * `null` until the first read has finished; afterwards the last good list —
   * which stays in place through a failed refresh (see `loadState`).
   */
  connections: WpManagerConnection[] | null;
  loadState: WpStoreLoadState;
  loadError: WpStoreLoadFailure | null;
  connectionsState: WpConnectionsState;
  /** Localized reason the last read failed; null after any successful read. */
  connectionsError: string | null;
  /** True while a (re)read of the connection list is in flight. */
  connectionsLoading: boolean;
  canSync: boolean;
  canEdit: boolean;
  selectedId: string;
  selectedConnection: WpManagerConnection | null;
  connectionsError: string | null;
  setSelectedId: (id: string) => void;
  reloadConnections: () => Promise<void>;
  /** The WP abilities the signed-in member holds (`src/lib/wp-access.ts`). */
  abilities: ReadonlySet<WpAbility>;
  can: (ability: WpAbility) => boolean;
}

const WpStoreContext = createContext<WpStoreContextValue | null>(null);

/** The storage key, per business, so one browser used for two tenants never carries a store id across. */
export function storageKeyFor(businessId: string | undefined): string {
  return businessId ? `${WP_SELECTED_STORE_STORAGE_KEY}:${businessId}` : WP_SELECTED_STORE_STORAGE_KEY;
}

function readRemembered(key: string): string {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) ?? "" : "";
  } catch {
    return "";
  }
}

function remember(key: string, id: string) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, id);
  } catch {
    // Private mode / quota — remembering the store is a convenience only.
  }
}

/**
 * Pick the store to show, in precedence order, each candidate validated
 * against the list that actually came back. Exported for the tests.
 */
export function resolveSelection(
  list: readonly { id: string }[],
  candidates: { chosen: string; query: string; remembered: string },
): string {
  const valid = (id: string) => Boolean(id) && list.some((connection) => connection.id === id);
  if (valid(candidates.chosen)) return candidates.chosen;
  if (valid(candidates.query)) return candidates.query;
  if (valid(candidates.remembered)) return candidates.remembered;
  return list[0]?.id ?? "";
}

export function WpStoreProvider({
  children,
  abilities: abilityList = [],
  businessId,
  caps,
}: {
  children: React.ReactNode;
  abilities?: readonly WpAbility[];
  /** Scopes the remembered selection; omitted only in tests. */
  businessId?: string;
  /** Section-resolution caps from `wp-routes`, OR-ed with the WP abilities. */
  caps?: WpSectionCaps;
}) {
  const locked = useFeatureLocked();
  const [connections, setConnections] = useState<WpManagerConnection[] | null>(() => (locked ? [] : null));
  const [loadState, setLoadState] = useState<WpStoreLoadState>(() => (locked ? "loaded" : "loading"));
  const [loadError, setLoadError] = useState<WpStoreLoadFailure | null>(null);
  const [selectedId, setSelectedIdState] = useState("");
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const storageKey = storageKeyFor(businessId);
  const storeParam = searchParams.get("store") ?? "";

  // Refs, not deps: a reload must read the *current* URL and the member's
  // latest pick when its response lands, without re-running on every URL
  // change (which is what made the old provider refetch per navigation and
  // then race itself).
  const storeParamRef = useRef(storeParam);
  storeParamRef.current = storeParam;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const routerRef = useRef(router);
  routerRef.current = router;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  /** The member's own latest pick this mount — outranks the URL and storage. */
  const chosenRef = useRef("");
  const generationRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  const syncUrl = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      const current = params.get("store") ?? "";
      if (id) params.set("store", id);
      else params.delete("store");
      // Only touch the URL when it actually differs — replacing it with
      // itself on every selection pass is how a redirect loop starts.
      if (current === id) return;
      const qs = params.toString();
      routerRef.current.replace(`${pathnameRef.current}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [],
  );

  const applySelection = useCallback(
    (id: string) => {
      setSelectedIdState(id);
      if (id) remember(storageKey, id);
      syncUrl(id);
    },
    [storageKey, syncUrl],
  );

  const choose = useCallback(
    (id: string) => {
      const list = connectionsRef.current ?? [];
      const safeId = list.some((connection) => connection.id === id) ? id : list[0]?.id ?? "";
      chosenRef.current = safeId;
      applySelection(safeId);
    },
    [applySelection],
  );

  const reloadConnections = useCallback(async () => {
    if (locked) {
      setConnections([]);
      setLoadState("loaded");
      setLoadError(null);
      setSelectedIdState("");
      return;
    }
    const generation = ++generationRef.current;
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    // A refresh keeps the last good list on screen; only the first read
    // shows the skeleton (connections === null).
    setLoadState("loading");

    const res = await api<{ connections?: WpManagerConnection[]; error?: string }>(WP_CONNECTIONS_ENDPOINT, {
      signal: controller.signal,
    });
    // A newer reload has started, or the provider unmounted: this response
    // is stale and must not touch state (#944 / OVR-05).
    if (generation !== generationRef.current || res.aborted) return;

    if (!res.ok) {
      setLoadState("error");
      setLoadError({ status: res.status, code: String(res.data?.error ?? "") });
      return;
    }
    if (!Array.isArray(res.data?.connections)) {
      setLoadState("error");
      setLoadError({ status: res.status || 502, code: "invalid_connections_response" });
      return;
    }
    const list = res.data.connections;
    setConnections(list);
    setLoadState("loaded");
    setLoadError(null);
    const next = resolveSelection(list, {
      chosen: chosenRef.current,
      query: storeParamRef.current,
      remembered: readRemembered(storageKey),
    });
    // The member's pick may have been a store that no longer exists; the
    // resolved id is now the truth for later resolutions too.
    chosenRef.current = next;
    applySelection(next);
  }, [locked, storageKey, applySelection]);

  useEffect(() => {
    void reloadConnections();
    return () => {
      // Unmount (or a business switch): retire every in-flight read.
      generationRef.current += 1;
      inFlightRef.current?.abort();
    };
  }, [reloadConnections]);

  // Browser back/forward (or a sibling page's link) changing `?store=` is a
  // selection the member made through the URL: follow it when it names a
  // store we have, and do nothing on URLs that do not mention a store.
  useEffect(() => {
    if (!storeParam || !connections) return;
    if (storeParam === selectedId) return;
    if (!connections.some((connection) => connection.id === storeParam)) return;
    chosenRef.current = storeParam;
    setSelectedIdState(storeParam);
    remember(storageKey, storeParam);
  }, [storeParam, connections, selectedId, storageKey]);

  const selectedConnection = useMemo(
    () => connections?.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const connectionsState: WpConnectionsState =
    connections !== null ? "ready" : loadState === "error" ? "error" : "loading";
  const connectionsError = loadError ? wpConnectionsErrorMessage(loadError.status) : null;
  const connectionsLoading = loadState === "loading";

  const abilities = useMemo(() => new Set<WpAbility>(abilityList), [abilityList]);
  const can = useCallback((ability: WpAbility) => abilities.has(ability), [abilities]);
  // The customer view has its own in-page refresh banner; derive its copy from
  // the same structured failure used by the overview and store host.
  const connectionsError = loadState === "error" && loadError
    ? describeStoreLoadFailure(loadError).detail
    : null;

  const value = useMemo<WpStoreContextValue>(
    () => ({
      connections,
      loadState,
      loadError,
      connectionsState,
      connectionsError,
      connectionsLoading,
      canSync: can("sync") || (caps?.canSync ?? false),
      canEdit: can("content_manage") || can("store_manage") || (caps?.canEdit ?? false),
      selectedId,
      selectedConnection,
      connectionsError,
      setSelectedId: choose,
      reloadConnections,
      abilities,
      can,
    }),
    [
      connections,
      loadState,
      loadError,
      connectionsState,
      connectionsError,
      connectionsLoading,
      caps,
      selectedId,
      selectedConnection,
      choose,
      reloadConnections,
      abilities,
      can,
    ],
  );

  let body: React.ReactNode;
  if (connections === null) {
    // No list has ever arrived: either still reading, or the first read
    // failed — and a failed first read is an error screen, never «هنوز
    // فروشگاهی متصل نیست» (#944 / OVR-02).
    body =
      loadState === "error" && loadError ? (
        <WpStoreLoadError failure={loadError} onRetry={() => void reloadConnections()} retrying={false} />
      ) : (
        <WpStoreLoadingSkeleton />
      );
  } else {
    body = children;
  }

  return <WpStoreContext.Provider value={value}>{body}</WpStoreContext.Provider>;
}

export function useWpStore() {
  const context = useContext(WpStoreContext);
  if (!context) throw new Error("useWpStore must be used inside WpStoreProvider");
  return context;
}
